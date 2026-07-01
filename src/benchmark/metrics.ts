import { CvsEngine } from "../engine.js";
import type { TrainingPosition } from "../types.js";
import type { CandidateMove } from "../types.js";
import { canonicalMove, positionBuckets, type BenchmarkBuckets } from "./manifest.js";

export interface BenchmarkOptions {
  /** Search depth used for the engine's pick. 0 = policy-only (no search). Default 0. */
  depth?: number;
  /** Per-position time budget in ms when depth > 0. */
  maxTimeMs?: number;
  /** How many policy candidates count toward top-k overlap. Default 3. */
  topK?: number;
  /** How many search root alternatives count toward search top-k overlap. Default topK. */
  searchTopK?: number;
  /** Centipawn threshold used for engine blunder rate. Default 200. */
  blunderThresholdCp?: number;
}

export interface BenchmarkReport {
  positions: number;
  /** Fraction where the engine's #1 move equals the dataset reference move. */
  top1Match: number;
  /** Fraction where the reference move appears in the engine's top-k policy. */
  topKMatch: number;
  /** Fraction where the reference move appears in search multiPV, when search is used. */
  searchTopKMatch: number;
  /** Mean centipawn loss vs the reference best move, when the dataset provides it. */
  avgCpLoss: number;
  /** Fraction of positions whose reference cpLoss marks a blunder (>= 200cp). */
  blunderRate: number;
  /** Fraction of mate-in-position references the engine also reports as mate. */
  mateDetectionRate: number;
  scoredForCpLoss: number;
  scoredForMate: number;
}

export interface ReferenceBucketMetrics extends BenchmarkReport {
  attempted: number;
  skipped: number;
  engineFailures: number;
}

export interface ReferenceBucketReport {
  phase: Record<string, ReferenceBucketMetrics>;
  source: Record<string, ReferenceBucketMetrics>;
  terminal: Record<string, ReferenceBucketMetrics>;
  tablebase: Record<string, ReferenceBucketMetrics>;
  classification: Record<string, ReferenceBucketMetrics>;
  purpose: Record<string, ReferenceBucketMetrics>;
  motif: Record<string, ReferenceBucketMetrics>;
}

export interface ReferenceBenchmarkRow {
  index: number;
  fen: string;
  reference: {
    input: string | null;
    san: string | null;
    uci: string | null;
  };
  engine: {
    san: string | null;
    uci: string | null;
    mode: "policy" | "search";
    scoreCp?: number;
    mate?: number;
    depth: number;
    seldepth: number;
    nodes: number;
    hashfull: number;
    aborted: boolean;
    abortReason?: "time" | "nodes" | "stop";
    elapsedMs: number;
    pv: string[];
  };
  policyTopK: string[];
  searchTopK: string[];
  top1Match: boolean;
  topKMatch: boolean;
  searchTopKMatch: boolean;
  cpLoss?: number;
  blunder?: boolean;
  mateExpected?: number;
  mateCorrect?: boolean;
  engineFailure?: string;
  skipped?: string;
  buckets: BenchmarkBuckets;
}

export interface ReferenceBenchmarkReport {
  kind: "reference";
  options: {
    depth: number;
    maxTimeMs?: number;
    topK: number;
    searchTopK: number;
    blunderThresholdCp: number;
  };
  summary: BenchmarkReport & {
    attempted: number;
    skipped: number;
    engineFailures: number;
    elapsedMs: number;
    totalNodes: number;
    nps: number;
    buckets: ReferenceBucketReport;
  };
  rows: ReferenceBenchmarkRow[];
}

const BLUNDER_CP = 200;

type ReferenceTopMove = NonNullable<TrainingPosition["topMoves"]>[number];

/**
 * Benchmark the engine against a labelled dataset. The reference move is the
 * dataset `bestMove` (falling back to `playedMove`). This implements the Phase 4
 * "compare against Stockfish" metrics: top-1 / top-k overlap, average centipawn
 * loss, blunder rate, and mate-detection rate — the measurable ladder rungs the
 * roadmap calls for.
 */
export function benchmark(
  positions: TrainingPosition[],
  engine: CvsEngine,
  options: BenchmarkOptions = {},
): BenchmarkReport {
  return runReferenceBenchmark(positions, engine, options).summary;
}

export function runReferenceBenchmark(
  positions: TrainingPosition[],
  engine: CvsEngine,
  options: BenchmarkOptions = {},
): ReferenceBenchmarkReport {
  const depth = options.depth ?? 0;
  const topK = options.topK ?? 3;
  const searchTopK = options.searchTopK ?? topK;
  const blunderThresholdCp = options.blunderThresholdCp ?? BLUNDER_CP;
  const started = Date.now();

  let top1 = 0;
  let topK_ = 0;
  let searchTopK_ = 0;
  let searchedRows = 0;
  let cpLossSum = 0;
  let cpLossCount = 0;
  let blunders = 0;
  let blunderable = 0;
  let mateHits = 0;
  let mateRefs = 0;
  let skipped = 0;
  let engineFailures = 0;
  let totalNodes = 0;
  const rows: ReferenceBenchmarkRow[] = [];

  for (let index = 0; index < positions.length; index++) {
    const pos = positions[index]!;
    const referenceInput = pos.bestMove ?? pos.playedMove ?? null;
    let reference = referenceInput ? canonicalMove(pos.fen, referenceInput) : null;
    let rowSkipped: string | undefined;
    if (referenceInput && !reference) {
      rowSkipped = `reference move is not legal in position: ${referenceInput}`;
      skipped++;
    }

    const candidates = engine.predict(pos.fen, Math.max(topK, 1));
    const policyTopK = candidates.slice(0, topK).map((c) => c.uci);
    let searchTopKMoves: string[] = [];

    let engineSan: string | null = null;
    let engineUci: string | null = null;
    let engineScoreCp: number | undefined;
    let engineMate: number | undefined;
    let engineDepth = 0;
    let engineSeldepth = 0;
    let engineNodes = 0;
    let engineHashfull = 0;
    let engineAborted = false;
    let engineAbortReason: "time" | "nodes" | "stop" | undefined;
    let enginePv: string[] = [];
    let engineFailure: string | undefined;
    const rowStart = Date.now();

    try {
      if (depth > 0) {
        const analysis = engine.analyze(pos.fen, {
          depth,
          maxTimeMs: options.maxTimeMs,
          candidates: topK,
          multiPv: searchTopK,
        });
        engineSan = analysis.bestMove?.san ?? null;
        engineUci = analysis.bestMove?.uci ?? null;
        engineScoreCp = analysis.scoreCp;
        engineMate = analysis.mate;
        engineDepth = analysis.depth;
        engineSeldepth = analysis.seldepth;
        engineNodes = analysis.nodes;
        engineHashfull = analysis.hashfull;
        engineAborted = analysis.aborted;
        engineAbortReason = analysis.abortReason;
        enginePv = analysis.pv;
        searchTopKMoves = analysis.multiPv.map((line) => line.move.uci);
      } else {
        const pick = candidates[0] ?? null;
        engineSan = pick?.san ?? null;
        engineUci = pick?.uci ?? null;
      }
    } catch (error) {
      engineFailures++;
      engineFailure = error instanceof Error ? error.message : String(error);
    }
    totalNodes += engineNodes;
    const elapsedMs = Date.now() - rowStart;

    if (!reference && referenceInput && !rowSkipped) {
      reference = canonicalMove(pos.fen, referenceInput);
    }

    const top1Match = Boolean(reference?.uci && engineUci && engineUci === reference.uci);
    const topKMatch = Boolean(reference?.uci && policyTopK.includes(reference.uci));
    const searchTopKMatch = Boolean(reference?.uci && searchTopKMoves.includes(reference.uci));

    if (top1Match) top1++;
    if (topKMatch) {
      topK_++;
    }
    if (depth > 0) {
      searchedRows++;
      if (searchTopKMatch) searchTopK_++;
    }

    const cpLoss = reference?.uci && engineUci ? engineCpLoss(pos, reference.uci, engineUci) : undefined;
    if (typeof cpLoss === "number") {
      cpLossSum += cpLoss;
      cpLossCount++;
      blunderable++;
      if (cpLoss >= blunderThresholdCp) blunders++;
    }

    const mateExpected = reference?.uci ? referenceMate(pos, reference.uci) : undefined;
    const mateCorrect =
      typeof mateExpected === "number"
        ? engineUci === reference?.uci && engineMate === mateExpected
        : undefined;
    if (typeof mateExpected === "number") {
      mateRefs++;
      if (mateCorrect) mateHits++;
    }

    rows.push({
      index,
      fen: pos.fen,
      reference: {
        input: referenceInput,
        san: reference?.san ?? null,
        uci: reference?.uci ?? null,
      },
      engine: {
        san: engineSan,
        uci: engineUci,
        mode: depth > 0 ? "search" : "policy",
        scoreCp: engineScoreCp,
        mate: engineMate,
        depth: engineDepth,
        seldepth: engineSeldepth,
        nodes: engineNodes,
        hashfull: engineHashfull,
        aborted: engineAborted,
        abortReason: engineAbortReason,
        elapsedMs,
        pv: enginePv,
      },
      policyTopK,
      searchTopK: searchTopKMoves,
      top1Match,
      topKMatch,
      searchTopKMatch,
      cpLoss,
      blunder: typeof cpLoss === "number" ? cpLoss >= blunderThresholdCp : undefined,
      mateExpected,
      mateCorrect,
      engineFailure,
      skipped: rowSkipped,
      buckets: positionBuckets(pos),
    });
  }

  const n = Math.max(positions.length, 1);
  const elapsedMs = Date.now() - started;
  const summary = {
    positions: positions.length,
    attempted: positions.length - skipped,
    skipped,
    engineFailures,
    top1Match: top1 / n,
    topKMatch: topK_ / n,
    searchTopKMatch: searchedRows ? searchTopK_ / searchedRows : 0,
    avgCpLoss: cpLossCount ? cpLossSum / cpLossCount : 0,
    blunderRate: blunderable ? blunders / blunderable : 0,
    mateDetectionRate: mateRefs ? mateHits / mateRefs : 0,
    scoredForCpLoss: cpLossCount,
    scoredForMate: mateRefs,
    elapsedMs,
    totalNodes,
    nps: elapsedMs > 0 ? Math.round((totalNodes * 1000) / elapsedMs) : 0,
    buckets: summarizeBuckets(rows),
  };

  return {
    kind: "reference",
    options: {
      depth,
      maxTimeMs: options.maxTimeMs,
      topK,
      searchTopK,
      blunderThresholdCp,
    },
    summary,
    rows,
  };
}

function engineCpLoss(pos: TrainingPosition, referenceUci: string, engineUci: string): number | undefined {
  const reference = topMove(pos, referenceUci);
  const engine = topMove(pos, engineUci);
  if (typeof reference?.cp !== "number" || typeof engine?.cp !== "number") return undefined;
  return Math.max(0, reference.cp - engine.cp);
}

function referenceMate(pos: TrainingPosition, referenceUci: string): number | undefined {
  const reference = topMove(pos, referenceUci);
  return typeof reference?.mate === "number" ? reference.mate : undefined;
}

function topMove(pos: TrainingPosition, uci: string): ReferenceTopMove | undefined {
  return pos.topMoves?.find((move) => normalizeMove(move.uci) === normalizeMove(uci));
}

function normalizeMove(move: string): string {
  return move.replace(/[+#!?]/g, "").trim().toLowerCase();
}

function summarizeBuckets(rows: ReferenceBenchmarkRow[]): ReferenceBucketReport {
  return {
    phase: bucketBy(rows, (row) => [row.buckets.phase]),
    source: bucketBy(rows, (row) => [row.buckets.source]),
    terminal: bucketBy(rows, (row) => [row.buckets.terminal]),
    tablebase: bucketBy(rows, (row) => [row.buckets.tablebase]),
    classification: bucketBy(rows, (row) => [row.buckets.classification]),
    purpose: bucketBy(rows, (row) => [row.buckets.purpose]),
    motif: bucketBy(rows, (row) => row.buckets.motifs.length ? row.buckets.motifs : ["no-motif"]),
  };
}

function bucketBy(
  rows: ReferenceBenchmarkRow[],
  keysOf: (row: ReferenceBenchmarkRow) => string[],
): Record<string, ReferenceBucketMetrics> {
  const grouped = new Map<string, ReferenceBenchmarkRow[]>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const bucketRows = grouped.get(key) ?? [];
      bucketRows.push(row);
      grouped.set(key, bucketRows);
    }
  }
  return Object.fromEntries([...grouped.entries()].map(([key, bucketRows]) => [key, summarizeRows(bucketRows)]));
}

function summarizeRows(rows: ReferenceBenchmarkRow[]): ReferenceBucketMetrics {
  const positions = rows.length;
  const cpRows = rows.filter((row) => typeof row.cpLoss === "number");
  const mateRows = rows.filter((row) => typeof row.mateExpected === "number");
  return {
    positions,
    attempted: rows.filter((row) => !row.skipped).length,
    skipped: rows.filter((row) => row.skipped).length,
    engineFailures: rows.filter((row) => row.engineFailure).length,
    top1Match: positions ? rows.filter((row) => row.top1Match).length / positions : 0,
    topKMatch: positions ? rows.filter((row) => row.topKMatch).length / positions : 0,
    searchTopKMatch: rows.some((row) => row.searchTopK.length > 0)
      ? rows.filter((row) => row.searchTopKMatch).length / rows.filter((row) => row.searchTopK.length > 0).length
      : 0,
    avgCpLoss: cpRows.length ? cpRows.reduce((sum, row) => sum + row.cpLoss!, 0) / cpRows.length : 0,
    blunderRate: cpRows.length ? cpRows.filter((row) => row.blunder).length / cpRows.length : 0,
    mateDetectionRate: mateRows.length ? mateRows.filter((row) => row.mateCorrect).length / mateRows.length : 0,
    scoredForCpLoss: cpRows.length,
    scoredForMate: mateRows.length,
  };
}
