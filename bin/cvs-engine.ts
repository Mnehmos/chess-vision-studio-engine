#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Chess } from "../src/chess.js";
import { CvsEngine } from "../src/engine.js";
import { extractPositionFeatures } from "../src/features/positionFeatures.js";
import { benchmark, runReferenceBenchmark } from "../src/benchmark/metrics.js";
import { loadDataset } from "../src/benchmark/dataset.js";
import { auditDataset } from "../src/benchmark/manifest.js";
import { BUILTIN_PERFT_CASES, runPerft } from "../src/benchmark/perft.js";
import { runRustSpeedBenchmark, runSpeedBenchmark } from "../src/benchmark/speed.js";
import { loadPerftCases, runBenchmarkSuiteFile } from "../src/benchmark/orchestrator.js";
import { runUciLoop } from "./uciLoop.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface Flags {
  positional: string[];
  depth?: number;
  k?: number;
  topK?: number;
  searchTopK?: number;
  moves?: number;
  maxTimeMs?: number;
  out?: string;
  blunderThresholdCp?: number;
  targetNps?: number;
  policyOrdering?: boolean;
  core?: "typescript" | "rust";
  name?: string;
  version?: string;
  purpose?: "fit" | "tuning" | "validation" | "release-test";
  scorePerspective?: "white" | "side-to-move" | "reference";
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--depth") flags.depth = Number(argv[++i]);
    else if (arg === "--k") flags.k = Number(argv[++i]);
    else if (arg === "--top-k") flags.topK = Number(argv[++i]);
    else if (arg === "--search-top-k") flags.searchTopK = Number(argv[++i]);
    else if (arg === "--moves") flags.moves = Number(argv[++i]);
    else if (arg === "--time") flags.maxTimeMs = Number(argv[++i]);
    else if (arg === "--target-nps") flags.targetNps = Number(argv[++i]);
    else if (arg === "--no-policy-ordering") flags.policyOrdering = false;
    else if (arg === "--core") flags.core = argv[++i] as Flags["core"];
    else if (arg === "--out") flags.out = argv[++i];
    else if (arg === "--blunder") flags.blunderThresholdCp = Number(argv[++i]);
    else if (arg === "--name") flags.name = argv[++i];
    else if (arg === "--version") flags.version = argv[++i];
    else if (arg === "--purpose") flags.purpose = argv[++i] as Flags["purpose"];
    else if (arg === "--score-perspective") flags.scorePerspective = argv[++i] as Flags["scorePerspective"];
    else flags.positional.push(arg);
  }
  return flags;
}

function fenOrStart(positional: string[]): string {
  return positional.length > 0 ? positional[0]! : START_FEN;
}

function formatScore(scoreCp: number, mate?: number): string {
  if (typeof mate === "number") {
    const moves = Math.ceil(Math.abs(mate) / 2);
    return `#${mate < 0 ? "-" : ""}${moves}`;
  }
  return (scoreCp / 100).toFixed(2);
}

function cmdAnalyze(flags: Flags): void {
  const fen = fenOrStart(flags.positional);
  const engine = new CvsEngine({ searchCore: flags.core });
  const depth = flags.depth ?? 4;
  const result = engine.analyze(fen, {
    depth,
    maxTimeMs: flags.maxTimeMs,
    candidates: flags.k ?? 5,
    searchCore: flags.core,
  });

  console.log(`FEN:        ${fen}`);
  console.log(`Best move:  ${result.bestMove?.san ?? "(none)"} (${result.bestMove?.uci ?? "-"})`);
  console.log(`Score:      ${formatScore(result.scoreCp, result.mate)} (depth ${result.depth}, ${result.nodes} nodes)`);
  console.log(`Static eval:${(result.staticEval / 100).toFixed(2)} (White's perspective)`);
  console.log(`PV:         ${result.pv.join(" ") || "(none)"}`);
  console.log("Policy candidates:");
  result.policy.forEach((c, i) => {
    console.log(
      `  ${i + 1}. ${c.san.padEnd(8)} p=${(c.prob * 100).toFixed(1)}%  ` +
        `see=${c.features.see} score=${c.score.toFixed(3)}`,
    );
  });
}

function cmdPredict(flags: Flags): void {
  const fen = fenOrStart(flags.positional);
  const engine = new CvsEngine();
  const candidates = engine.predict(fen, flags.k ?? 5);
  console.log(`FEN: ${fen}`);
  console.log("Policy candidates (no search):");
  candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.san.padEnd(8)} p=${(c.prob * 100).toFixed(1)}%  score=${c.score.toFixed(3)}`);
  });
}

function cmdEval(flags: Flags): void {
  const fen = fenOrStart(flags.positional);
  const engine = new CvsEngine();
  console.log(`${(engine.evaluate(fen) / 100).toFixed(2)} (centipawns / 100, White's perspective)`);
}

function cmdFeatures(flags: Flags): void {
  const fen = fenOrStart(flags.positional);
  console.log(JSON.stringify(extractPositionFeatures(fen), null, 2));
}

function cmdSelfplay(flags: Flags): void {
  const engine = new CvsEngine();
  const depth = flags.depth ?? 3;
  const maxMoves = flags.moves ?? 40;
  const chess = new Chess(flags.positional[0] ?? START_FEN);
  const sans: string[] = [];

  for (let ply = 0; ply < maxMoves * 2; ply++) {
    if (chess.isGameOver()) break;
    const best = engine.bestMove(chess.fen(), { depth, maxTimeMs: flags.maxTimeMs, searchCore: flags.core });
    if (!best) break;
    const applied = chess.move({ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), promotion: best.uci.slice(4) || undefined });
    if (!applied) break;
    sans.push(applied.san);
  }

  let pgn = "";
  for (let i = 0; i < sans.length; i += 2) {
    pgn += `${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? " " + sans[i + 1] : ""} `;
  }
  console.log(pgn.trim());
  console.log(`Result: ${gameResult(chess)} after ${sans.length} plies`);
}

function gameResult(chess: Chess): string {
  if (chess.isCheckmate()) return chess.turn() === "w" ? "0-1 (black mates)" : "1-0 (white mates)";
  if (chess.isStalemate()) return "1/2-1/2 (stalemate)";
  if (chess.isDraw()) return "1/2-1/2 (draw)";
  return "* (unfinished)";
}

function cmdBench(flags: Flags): void {
  const subcommand = flags.positional[0];
  if (subcommand === "reference") {
    cmdBenchReference(flags);
    return;
  }
  if (subcommand === "perft") {
    cmdBenchPerft(flags);
    return;
  }
  if (subcommand === "speed") {
    cmdBenchSpeed(flags);
    return;
  }
  if (subcommand === "suite") {
    cmdBenchSuite(flags);
    return;
  }
  if (subcommand === "manifest" || subcommand === "validate") {
    cmdBenchManifest(flags);
    return;
  }

  const path = subcommand;
  if (!path) {
    console.error("usage: cvs-engine bench <dataset.jsonl> [--depth N]");
    process.exit(1);
    return;
  }
  const positions = loadDataset(path);
  const engine = new CvsEngine({ searchCore: flags.core });
  const report = benchmark(positions, engine, { depth: flags.depth ?? 0 });
  emitJson(report, flags.out);
}

function cmdBenchManifest(flags: Flags): void {
  const path = flags.positional[1];
  if (!path) {
    console.error("usage: cvs-engine bench manifest <dataset.jsonl> [--name NAME] [--version VERSION] [--purpose validation|release-test] [--score-perspective white|side-to-move|reference] [--out report.json]");
    process.exit(1);
    return;
  }
  const positions = loadDataset(path);
  const report = auditDataset(positions, {
    name: flags.name,
    version: flags.version,
    purpose: flags.purpose,
    scorePerspective: flags.scorePerspective,
    source: path,
  });
  emitJson(report, flags.out);
}

function cmdBenchReference(flags: Flags): void {
  const path = flags.positional[1];
  if (!path) {
    console.error("usage: cvs-engine bench reference <dataset.jsonl> [--depth N] [--top-k N] [--search-top-k N] [--time MS] [--out report.json]");
    process.exit(1);
    return;
  }
  const positions = loadDataset(path);
  const report = runReferenceBenchmark(positions, new CvsEngine({ searchCore: flags.core }), {
    depth: flags.depth ?? 0,
    maxTimeMs: flags.maxTimeMs,
    topK: flags.topK ?? flags.k ?? 3,
    searchTopK: flags.searchTopK,
    blunderThresholdCp: flags.blunderThresholdCp,
  });
  emitJson(report, flags.out);
}

function cmdBenchPerft(flags: Flags): void {
  const path = flags.positional[1];
  const cases = path ? loadPerftCases(path) : BUILTIN_PERFT_CASES;
  const effectiveCases =
    flags.depth === undefined
      ? cases
      : cases.map((testCase) => ({ ...testCase, depth: flags.depth!, expected: undefined }));
  emitJson(runPerft(effectiveCases), flags.out);
}

function cmdBenchSpeed(flags: Flags): void {
  const options = {
    depth: flags.depth,
    maxTimeMs: flags.maxTimeMs,
    targetNps: flags.targetNps,
    policyOrdering: flags.policyOrdering,
  };
  emitJson(
    flags.core === "rust" ? runRustSpeedBenchmark(options) : runSpeedBenchmark(undefined, options),
    flags.out,
  );
}

function cmdBenchSuite(flags: Flags): void {
  const path = flags.positional[1];
  if (!path) {
    console.error("usage: cvs-engine bench suite <suite.json> [--out report.json]");
    process.exit(1);
    return;
  }
  emitJson(runBenchmarkSuiteFile(path, { out: flags.out }), undefined);
}

function emitJson(value: unknown, out?: string): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!out) {
    console.log(text.trimEnd());
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, "utf8");
  console.log(out);
}

function usage(): void {
  console.log(`cvs-engine — Chess Vision Studio Engine CLI

Usage:
  cvs-engine analyze  "<fen>" [--core typescript|rust] [--depth N] [--time MS] [--k N]
  cvs-engine predict  "<fen>" [--k N]
  cvs-engine eval     "<fen>"
  cvs-engine features "<fen>"
  cvs-engine selfplay ["<fen>"] [--core typescript|rust] [--moves N] [--depth N]
  cvs-engine bench    <dataset.jsonl> [--depth N]
  cvs-engine bench reference <dataset.jsonl> [--core typescript|rust] [--depth N] [--top-k N] [--search-top-k N] [--time MS] [--out report.json]
  cvs-engine bench manifest <dataset.jsonl> [--name NAME] [--version VERSION] [--purpose validation|release-test] [--score-perspective white|side-to-move|reference] [--out report.json]
  cvs-engine bench perft [perft.json|perft.jsonl] [--depth N] [--out report.json]
  cvs-engine bench speed [--core typescript|rust] [--depth N] [--time MS] [--target-nps N] [--no-policy-ordering] [--out report.json]
  cvs-engine bench suite <suite.json> [--out report.json]
  cvs-engine uci

FEN defaults to the starting position when omitted.`);
}

function main(): void {
  const [, , command, ...rest] = process.argv;
  const flags = parseArgs(rest);
  switch (command) {
    case "analyze":
      cmdAnalyze(flags);
      break;
    case "predict":
      cmdPredict(flags);
      break;
    case "eval":
      cmdEval(flags);
      break;
    case "features":
      cmdFeatures(flags);
      break;
    case "selfplay":
      cmdSelfplay(flags);
      break;
    case "bench":
      cmdBench(flags);
      break;
    case "uci":
      runUciLoop();
      break;
    default:
      usage();
  }
}

main();
