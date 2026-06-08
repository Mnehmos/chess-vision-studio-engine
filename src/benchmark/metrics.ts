import { CvsEngine } from "../engine.js";
import type { TrainingPosition } from "../types.js";

export interface BenchmarkOptions {
  /** Search depth used for the engine's pick. 0 = policy-only (no search). Default 0. */
  depth?: number;
  /** Per-position time budget in ms when depth > 0. */
  maxTimeMs?: number;
  /** How many policy candidates count toward top-k overlap. Default 3. */
  topK?: number;
}

export interface BenchmarkReport {
  positions: number;
  /** Fraction where the engine's #1 move equals the dataset reference move. */
  top1Match: number;
  /** Fraction where the reference move appears in the engine's top-k policy. */
  topKMatch: number;
  /** Mean centipawn loss vs the reference best move, when the dataset provides it. */
  avgCpLoss: number;
  /** Fraction of positions whose reference cpLoss marks a blunder (>= 200cp). */
  blunderRate: number;
  /** Fraction of mate-in-position references the engine also reports as mate. */
  mateDetectionRate: number;
  scoredForCpLoss: number;
  scoredForMate: number;
}

const BLUNDER_CP = 200;

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
  const depth = options.depth ?? 0;
  const topK = options.topK ?? 3;

  let top1 = 0;
  let topK_ = 0;
  let cpLossSum = 0;
  let cpLossCount = 0;
  let blunders = 0;
  let blunderable = 0;
  let mateHits = 0;
  let mateRefs = 0;

  for (const pos of positions) {
    const reference = pos.bestMove ?? pos.playedMove;
    const candidates = engine.predict(pos.fen, Math.max(topK, 1));

    let enginePick = candidates[0]?.san ?? candidates[0]?.uci ?? null;
    if (depth > 0) {
      const best = engine.bestMove(pos.fen, { depth, maxTimeMs: options.maxTimeMs });
      if (best) enginePick = best.san;
    }

    if (reference && enginePick && movesEqual(enginePick, reference)) top1++;
    if (reference && candidates.some((c) => movesEqual(c.san, reference) || movesEqual(c.uci, reference))) {
      topK_++;
    }

    if (typeof pos.cpLoss === "number") {
      cpLossSum += Math.abs(pos.cpLoss);
      cpLossCount++;
      blunderable++;
      if (Math.abs(pos.cpLoss) >= BLUNDER_CP) blunders++;
    }

    const refIsMate = pos.topMoves?.some((m) => typeof m.mate === "number");
    if (refIsMate) {
      mateRefs++;
      const analysis = engine.analyze(pos.fen, { depth: Math.max(depth, 3) });
      if (typeof analysis.mate === "number") mateHits++;
    }
  }

  const n = Math.max(positions.length, 1);
  return {
    positions: positions.length,
    top1Match: top1 / n,
    topKMatch: topK_ / n,
    avgCpLoss: cpLossCount ? cpLossSum / cpLossCount : 0,
    blunderRate: blunderable ? blunders / blunderable : 0,
    mateDetectionRate: mateRefs ? mateHits / mateRefs : 0,
    scoredForCpLoss: cpLossCount,
    scoredForMate: mateRefs,
  };
}

function movesEqual(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(move: string): string {
  return move.replace(/[+#!?]/g, "").trim();
}
