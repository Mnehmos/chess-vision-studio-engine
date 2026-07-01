import { Chess } from "../chess.js";

export interface PerftCase {
  name?: string;
  fen: string;
  depth: number;
  expected?: number;
}

export interface PerftRow {
  name: string;
  fen: string;
  depth: number;
  nodes: number;
  expected?: number;
  passed?: boolean;
  elapsedMs: number;
  nps: number;
}

export interface PerftReport {
  kind: "perft";
  positions: number;
  passed: number;
  failed: number;
  totalNodes: number;
  elapsedMs: number;
  nps: number;
  rows: PerftRow[];
}

export const BUILTIN_PERFT_CASES: PerftCase[] = [
  {
    name: "startpos d1",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    depth: 1,
    expected: 20,
  },
  {
    name: "startpos d2",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    depth: 2,
    expected: 400,
  },
  {
    name: "kiwipete d1",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    depth: 1,
    expected: 48,
  },
  {
    name: "kiwipete d2",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    depth: 2,
    expected: 2039,
  },
  {
    name: "open castling d1",
    fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    depth: 1,
    expected: 26,
  },
  {
    name: "en-passant d1",
    fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    depth: 1,
    expected: 7,
  },
  {
    name: "promotion d1",
    fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
    depth: 1,
    expected: 9,
  },
  {
    name: "check evasion d1",
    fen: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
    depth: 1,
    expected: 3,
  },
  {
    name: "illegal castling through check d1",
    fen: "r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1",
    depth: 1,
    expected: 23,
  },
  {
    name: "absolute pin d1",
    fen: "k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1",
    depth: 1,
    expected: 10,
  },
];

export function perft(fen: string, depth: number): number {
  return perftFrom(new Chess(fen), depth);
}

export function runPerft(cases: PerftCase[]): PerftReport {
  const started = Date.now();
  const rows: PerftRow[] = [];
  let passed = 0;
  let failed = 0;
  let totalNodes = 0;

  for (const [index, testCase] of cases.entries()) {
    const rowStarted = Date.now();
    const nodes = perft(testCase.fen, testCase.depth);
    const elapsedMs = Date.now() - rowStarted;
    const row: PerftRow = {
      name: testCase.name ?? `perft-${index + 1}`,
      fen: testCase.fen,
      depth: testCase.depth,
      nodes,
      expected: testCase.expected,
      passed: typeof testCase.expected === "number" ? nodes === testCase.expected : undefined,
      elapsedMs,
      nps: elapsedMs > 0 ? Math.round((nodes * 1000) / elapsedMs) : 0,
    };
    totalNodes += nodes;
    if (row.passed === true) passed++;
    else if (row.passed === false) failed++;
    rows.push(row);
  }

  const elapsedMs = Date.now() - started;
  return {
    kind: "perft",
    positions: cases.length,
    passed,
    failed,
    totalNodes,
    elapsedMs,
    nps: elapsedMs > 0 ? Math.round((totalNodes * 1000) / elapsedMs) : 0,
    rows,
  };
}

function perftFrom(chess: Chess, depth: number): number {
  if (depth <= 0) return 1;
  const moves = chess.moves({ verbose: true, san: false, fen: false });
  if (depth === 1) return moves.length;

  let nodes = 0;
  for (const move of moves) {
    chess.push(move);
    nodes += perftFrom(chess, depth - 1);
    chess.undo();
  }
  return nodes;
}
