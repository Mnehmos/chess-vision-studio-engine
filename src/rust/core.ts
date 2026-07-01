import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "../chess.js";
import type { SearchOptions, SearchResult } from "../search/searchEngine.js";

interface RustSearchJson {
  kind: "search";
  core: "rust";
  fen: string;
  depth: number;
  seldepth: number;
  bestMove: string | null;
  scoreCp: number;
  mate: number | null;
  pv: string[];
  multiPv: RustPvLine[];
  nodes: number;
  hashfull: number;
  elapsedMs: number;
  nps: number;
  aborted: boolean;
  abortReason: "time" | "nodes" | "stop" | null;
}

interface RustPvLine {
  move: string;
  scoreCp: number;
  mate: number | null;
  pv: string[];
}

export function rustCoreBinaryPath(): string | null {
  const exe = process.platform === "win32" ? "cvs-rust-core.exe" : "cvs-rust-core";
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "rust", "cvs-core", "target", "release", exe),
    resolve(here, "..", "..", "..", "rust", "cvs-core", "target", "release", exe),
    resolve(here, "..", "..", "rust", "cvs-core", "target", "release", exe),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function runRustCoreJson<T>(args: string[]): T {
  const binary = rustCoreBinaryPath();
  if (!binary) throw new Error("Rust core binary not found. Run `npm run rust:build` first.");

  const result = spawnSync(binary, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Rust core exited with status ${result.status}`);
  }
  return JSON.parse(result.stdout) as T;
}

export function runRustSearch(fen: string, options: SearchOptions = {}): SearchResult {
  const args = ["search", "--fen", fen, "--depth", String(Math.max(1, options.depth ?? 4))];
  if (options.maxTimeMs !== undefined) args.push("--time", String(options.maxTimeMs));
  if (options.maxNodes !== undefined) args.push("--nodes", String(options.maxNodes));
  if (options.multiPv !== undefined && options.multiPv > 1) {
    args.push("--multipv", String(Math.max(1, options.multiPv)));
  }
  if (options.searchMoves && options.searchMoves.length > 0) {
    args.push("--searchmoves", ...options.searchMoves.map((move) => move.toLowerCase()));
  }

  const raw = runRustCoreJson<RustSearchJson>(args);
  const bestMove = raw.bestMove ? describeUciMove(fen, raw.bestMove) : null;
  const multiPv = raw.multiPv.map((line) => ({
    move: describeUciMove(fen, line.move),
    scoreCp: line.scoreCp,
    ...(line.mate !== null ? { mate: line.mate } : {}),
    pv: line.pv,
  }));
  return {
    bestMove,
    scoreCp: raw.scoreCp,
    ...(raw.mate !== null ? { mate: raw.mate } : {}),
    pv: raw.pv,
    multiPv,
    depth: raw.depth,
    seldepth: raw.seldepth,
    nodes: raw.nodes,
    hashfull: raw.hashfull,
    aborted: raw.aborted,
    ...(raw.abortReason ? { abortReason: raw.abortReason } : {}),
  };
}

function describeUciMove(fen: string, uci: string): { san: string; uci: string } {
  const chess = new Chess(fen);
  const applied = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.slice(4) || undefined,
  });
  return { san: applied?.san ?? uci, uci };
}
