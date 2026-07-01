import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, release } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "../chess.js";
import type {
  DatasetPurpose,
  ScorePerspective,
  TablebaseClass,
  TerminalClass,
  TrainingPosition,
} from "../types.js";

export interface BenchmarkEnvironment {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  cpu: string;
  cpuCount: number;
  cwd: string;
  gitSha: string | null;
  packageVersion: string | null;
  buildMode: "source" | "dist";
}

export interface BenchmarkBuckets {
  phase: string;
  source: string;
  terminal: TerminalClass;
  tablebase: TablebaseClass;
  classification: string;
  motifs: string[];
  purpose: DatasetPurpose | "unspecified";
}

export interface DatasetManifestOptions {
  name?: string;
  version?: string;
  purpose?: DatasetPurpose;
  scorePerspective?: ScorePerspective;
  source?: string;
}

export interface DatasetManifest {
  schemaVersion: 1;
  kind: "dataset-manifest";
  name: string;
  version: string;
  purpose: DatasetPurpose | "unspecified";
  source?: string;
  checksum: string;
  checksumAlgorithm: "sha256";
  positions: number;
  uniquePositions: number;
  duplicates: number;
  scorePerspective: ScorePerspective | "mixed" | "unspecified";
  bucketCounts: BucketCountMap;
  motifLabels: string[];
  allReferenceMovesLegal: boolean;
  allReferenceMovesHaveUciSan: boolean;
}

export interface DatasetAuditIssue {
  severity: "error" | "warning";
  index: number;
  code: string;
  message: string;
}

export interface DatasetAuditReport {
  manifest: DatasetManifest;
  issues: DatasetAuditIssue[];
  deduplicatedPositions: TrainingPosition[];
}

export interface CanonicalMove {
  san: string;
  uci: string;
}

interface BucketCountMap {
  phase: Record<string, number>;
  source: Record<string, number>;
  terminal: Record<string, number>;
  tablebase: Record<string, number>;
  classification: Record<string, number>;
  purpose: Record<string, number>;
  motif: Record<string, number>;
}

export function createEnvironment(cwd = process.cwd()): BenchmarkEnvironment {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    cwd,
    gitSha: readGitSha(cwd),
    packageVersion: readPackageVersion(cwd),
    buildMode: cwd.includes(`${process.platform === "win32" ? "\\" : "/"}dist`) ? "dist" : "source",
  };
}

export function auditDataset(
  positions: TrainingPosition[],
  options: DatasetManifestOptions = {},
): DatasetAuditReport {
  const issues: DatasetAuditIssue[] = [];
  const seen = new Set<string>();
  const deduplicatedPositions: TrainingPosition[] = [];
  const motifLabels = new Set<string>();
  const bucketCounts: BucketCountMap = {
    phase: {},
    source: {},
    terminal: {},
    tablebase: {},
    classification: {},
    purpose: {},
    motif: {},
  };
  let illegalReferenceMoves = 0;
  let missingUciSan = 0;
  const scorePerspectives = new Set<ScorePerspective>();

  positions.forEach((position, index) => {
    let key: string;
    try {
      key = normalizedFenKey(position.fen);
    } catch (error) {
      key = `invalid-${index}`;
      issues.push({
        severity: "error",
        index,
        code: "invalid-fen",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (seen.has(key!)) {
      issues.push({
        severity: "warning",
        index,
        code: "duplicate-position",
        message: `Duplicate normalized FEN/hash: ${key!}`,
      });
    } else {
      seen.add(key!);
      deduplicatedPositions.push(position);
    }

    const perspective = position.scorePerspective ?? options.scorePerspective;
    if (perspective) scorePerspectives.add(perspective);
    else {
      issues.push({
        severity: "warning",
        index,
        code: "missing-score-perspective",
        message: "Centipawn score perspective is not explicit.",
      });
    }

    const referenceInput = position.bestMove ?? position.playedMove;
    const canonical = referenceInput ? canonicalMove(position.fen, referenceInput) : null;
    if (referenceInput && !canonical) {
      illegalReferenceMoves++;
      issues.push({
        severity: "error",
        index,
        code: "illegal-reference-move",
        message: `Reference move is not legal in position: ${referenceInput}`,
      });
    }
    if (!canonical) missingUciSan++;

    for (const topMove of position.topMoves ?? []) {
      if (!topMove.uci || !topMove.san) missingUciSan++;
      if (!topMove.scorePerspective && !perspective) {
        issues.push({
          severity: "warning",
          index,
          code: "top-move-missing-score-perspective",
          message: `Top move ${topMove.uci || topMove.san} has no explicit score perspective.`,
        });
      }
    }

    const buckets = positionBuckets(position);
    increment(bucketCounts.phase, buckets.phase);
    increment(bucketCounts.source, buckets.source);
    increment(bucketCounts.terminal, buckets.terminal);
    increment(bucketCounts.tablebase, buckets.tablebase);
    increment(bucketCounts.classification, buckets.classification);
    increment(bucketCounts.purpose, buckets.purpose);
    for (const motif of buckets.motifs) {
      motifLabels.add(motif);
      increment(bucketCounts.motif, motif);
    }
  });

  const scorePerspective =
    scorePerspectives.size === 0
      ? "unspecified"
      : scorePerspectives.size === 1
        ? [...scorePerspectives][0]!
        : "mixed";

  return {
    manifest: {
      schemaVersion: 1,
      kind: "dataset-manifest",
      name: options.name ?? "benchmark-dataset",
      version: options.version ?? "unversioned",
      purpose: options.purpose ?? "unspecified",
      source: options.source,
      checksum: checksumDataset(positions),
      checksumAlgorithm: "sha256",
      positions: positions.length,
      uniquePositions: seen.size,
      duplicates: positions.length - seen.size,
      scorePerspective,
      bucketCounts,
      motifLabels: [...motifLabels].sort(),
      allReferenceMovesLegal: illegalReferenceMoves === 0,
      allReferenceMovesHaveUciSan: missingUciSan === 0,
    },
    issues,
    deduplicatedPositions,
  };
}

export function canonicalMove(fen: string, move: string): CanonicalMove | null {
  const normalized = normalizeMove(move);
  const chess = new Chess(fen);
  for (const legal of chess.moves({ verbose: true })) {
    if (normalizeMove(legal.lan) === normalized || normalizeMove(legal.san) === normalized) {
      return { san: legal.san, uci: legal.lan };
    }
  }
  return null;
}

export function positionBuckets(position: TrainingPosition): BenchmarkBuckets {
  const chess = new Chess(position.fen);
  const pieceCount = chess
    .board()
    .flat()
    .filter(Boolean).length;
  return {
    phase: position.features?.phase ?? "unknown",
    source: position.source ?? "unknown",
    terminal: terminalClass(chess),
    tablebase: position.tablebaseClass ?? (pieceCount <= 7 ? "candidate-7-piece" : "out-of-scope"),
    classification: normalizeLabel(position.classification ?? "unclassified"),
    motifs: normalizeMotifs(position.features?.motifs ?? []),
    purpose: position.suitePurpose ?? "unspecified",
  };
}

export function checksumValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function checksumText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function checksumDataset(positions: TrainingPosition[]): string {
  return checksumValue(
    positions.map((position) => ({
      ...position,
      fenKey: safeFenKey(position.fen),
    })),
  );
}

export function normalizedFenKey(fen: string): string {
  const normalized = new Chess(fen).fen().split(/\s+/).slice(0, 4).join(" ");
  return checksumText(normalized);
}

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unclassified";
}

function normalizeMotifs(motifs: string[]): string[] {
  return [...new Set(motifs.map(normalizeLabel).filter(Boolean))].sort();
}

function terminalClass(chess: Chess): TerminalClass {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDraw()) return "draw";
  return "ongoing";
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function normalizeMove(move: string): string {
  return move.replace(/[+#!?]/g, "").trim().toLowerCase();
}

function safeFenKey(fen: string): string {
  try {
    return normalizedFenKey(fen);
  } catch {
    return checksumText(fen);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function readGitSha(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
