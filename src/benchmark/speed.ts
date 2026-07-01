import { performance } from "node:perf_hooks";
import { search, type SearchOptions } from "../search/searchEngine.js";
import { runRustCoreJson } from "../rust/core.js";

export interface SpeedCase {
  name: string;
  fen: string;
}

export interface SpeedBenchmarkOptions extends Pick<SearchOptions, "depth" | "maxTimeMs" | "policyOrdering"> {
  targetNps?: number;
}

export interface SpeedBenchmarkRow {
  name: string;
  fen: string;
  depth: number;
  bestMove?: string;
  scoreCp: number;
  nodes: number;
  elapsedMs: number;
  nps: number;
  aborted: boolean;
  abortReason?: "time" | "nodes" | "stop";
}

export interface SpeedBenchmarkReport {
  kind: "speed";
  core: "typescript" | "rust";
  targetNps: number;
  passed: boolean;
  positions: number;
  depth: number;
  policyOrdering: boolean;
  totalNodes: number;
  elapsedMs: number;
  nps: number;
  rows: SpeedBenchmarkRow[];
}

export const DEFAULT_SPEED_TARGET_NPS = 1_000_000;

export const BUILTIN_SPEED_CASES: SpeedCase[] = [
  {
    name: "startpos",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  },
  {
    name: "kiwipete",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/2PpP3/1p2P3/2N2N2/PPQPBPPP/R3K2R w KQkq - 0 1",
  },
  {
    name: "hanging queen",
    fen: "rnb1kbnr/pppp1ppp/8/3qp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3",
  },
  {
    name: "queen trap",
    fen: "rnbqkbnr/pp2pppp/2p5/3p4/8/3Q4/PPPP1PPP/RNB1KBNR w KQkq - 0 1",
  },
  {
    name: "rook endgame",
    fen: "8/5pk1/6p1/8/8/6P1/5PK1/4R3 w - - 0 1",
  },
];

export function runSpeedBenchmark(
  cases: SpeedCase[] = BUILTIN_SPEED_CASES,
  options: SpeedBenchmarkOptions = {},
): SpeedBenchmarkReport {
  const depth = Math.max(1, options.depth ?? 4);
  const targetNps = options.targetNps ?? DEFAULT_SPEED_TARGET_NPS;
  const policyOrdering = options.policyOrdering ?? true;
  const rows: SpeedBenchmarkRow[] = [];
  let totalNodes = 0;
  let totalElapsed = 0;

  for (const testCase of cases) {
    const started = performance.now();
    const result = search(testCase.fen, {
      depth,
      maxTimeMs: options.maxTimeMs,
      policyOrdering,
    });
    const elapsedMs = performance.now() - started;
    const roundedElapsed = Math.max(1, Math.round(elapsedMs));
    const nps = Math.round((result.nodes * 1000) / Math.max(1, elapsedMs));
    totalNodes += result.nodes;
    totalElapsed += elapsedMs;
    rows.push({
      name: testCase.name,
      fen: testCase.fen,
      depth: result.depth,
      bestMove: result.bestMove?.uci,
      scoreCp: result.scoreCp,
      nodes: result.nodes,
      elapsedMs: roundedElapsed,
      nps,
      aborted: result.aborted,
      ...(result.abortReason ? { abortReason: result.abortReason } : {}),
    });
  }

  const elapsedMs = Math.max(1, Math.round(totalElapsed));
  const nps = Math.round((totalNodes * 1000) / Math.max(1, totalElapsed));

  return {
    kind: "speed",
    core: "typescript",
    targetNps,
    passed: nps >= targetNps,
    positions: cases.length,
    depth,
    policyOrdering,
    totalNodes,
    elapsedMs,
    nps,
    rows,
  };
}

export function runRustSpeedBenchmark(options: SpeedBenchmarkOptions = {}): SpeedBenchmarkReport {
  const args = ["speed"];
  if (options.depth !== undefined) args.push("--depth", String(options.depth));
  if (options.maxTimeMs !== undefined) args.push("--time", String(options.maxTimeMs));
  if (options.targetNps !== undefined) args.push("--target-nps", String(options.targetNps));

  return runRustCoreJson<SpeedBenchmarkReport>(args);
}
