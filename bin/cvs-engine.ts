#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Chess } from "chess.js";
import { CvsEngine } from "../src/engine.js";
import { UciSession } from "../src/uci.js";
import { extractPositionFeatures } from "../src/features/positionFeatures.js";
import { benchmark } from "../src/benchmark/metrics.js";
import { loadDataset } from "../src/benchmark/dataset.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface Flags {
  positional: string[];
  depth?: number;
  k?: number;
  moves?: number;
  maxTimeMs?: number;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--depth") flags.depth = Number(argv[++i]);
    else if (arg === "--k") flags.k = Number(argv[++i]);
    else if (arg === "--moves") flags.moves = Number(argv[++i]);
    else if (arg === "--time") flags.maxTimeMs = Number(argv[++i]);
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
  const engine = new CvsEngine();
  const depth = flags.depth ?? 4;
  const result = engine.analyze(fen, { depth, maxTimeMs: flags.maxTimeMs, candidates: flags.k ?? 5 });

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
    const best = engine.bestMove(chess.fen(), { depth, maxTimeMs: flags.maxTimeMs });
    if (!best) break;
    const applied = chess.move({ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), promotion: best.uci.slice(4) || undefined });
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
  const path = flags.positional[0];
  if (!path) {
    console.error("usage: cvs-engine bench <dataset.jsonl> [--depth N]");
    process.exit(1);
    return;
  }
  const positions = loadDataset(path);
  const engine = new CvsEngine();
  const report = benchmark(positions, engine, { depth: flags.depth ?? 0 });
  console.log(JSON.stringify(report, null, 2));
}

/** UCI protocol mode: read commands from stdin, answer on stdout, until `quit`.
 *  Launch as `cvs-engine uci` from a UCI GUI / cutechess-cli / lichess-bot. */
function cmdUci(flags: Flags): void {
  const session = new UciSession(new CvsEngine(), { defaultDepth: flags.depth ?? 4, maxMoveMs: flags.maxTimeMs });
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const { out, quit } = session.handle(line);
    for (const o of out) process.stdout.write(o + "\n");
    if (quit) {
      rl.close();
      process.exit(0);
    }
  });
}

function usage(): void {
  console.log(`cvs-engine — Chess Vision Studio Engine CLI

Usage:
  cvs-engine analyze  "<fen>" [--depth N] [--time MS] [--k N]
  cvs-engine predict  "<fen>" [--k N]
  cvs-engine eval     "<fen>"
  cvs-engine features "<fen>"
  cvs-engine selfplay ["<fen>"] [--moves N] [--depth N]
  cvs-engine bench    <dataset.jsonl> [--depth N]
  cvs-engine uci      [--depth N] [--time MS]   (UCI protocol on stdin/stdout)

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
      cmdUci(flags);
      break;
    default:
      usage();
  }
}

main();
