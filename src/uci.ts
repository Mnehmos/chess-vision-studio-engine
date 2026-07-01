import { Chess } from "./chess.js";
import type { PieceSymbol } from "./chess.js";
import { search, type SearchOptions, type SearchResult } from "./search/searchEngine.js";
import { phaseLabel } from "./value/valueEngine.js";

const ENGINE_NAME = "Chess Vision Studio Engine";
const ENGINE_AUTHOR = "Chess Vision Studio";
const STARTPOS = "startpos";
const FEN = "fen";
const MOVES = "moves";

export interface UciSessionOptions {
  /** Engine name reported during the UCI handshake. */
  name?: string;
  /** Engine author reported during the UCI handshake. */
  author?: string;
  /** Depth used for `go` when no depth or time budget is supplied. */
  defaultDepth?: number;
  /** Depth cap used when a time budget is supplied without an explicit depth. */
  timedSearchDepth?: number;
  /** Time reserve subtracted from UCI clock budgets. */
  moveOverheadMs?: number;
  /** Enable policy-prior search ordering. */
  policyOrdering?: boolean;
  /** Multiplier applied to policy logits inside search move ordering. */
  policyOrderingWeight?: number;
}

interface GoOptions extends SearchOptions {
  infinite: boolean;
  ponder: boolean;
}

interface TimeControl {
  wtime?: number;
  btime?: number;
  winc?: number;
  binc?: number;
  movestogo?: number;
  movetime?: number;
  nodes?: number;
  mate?: number;
  searchmoves?: string[];
}

/**
 * A synchronous Universal Chess Interface session.
 *
 * The session owns the current UCI position, accepts one command line at a time,
 * and returns the protocol lines that should be written to stdout.
 */
export class UciSession {
  private readonly name: string;
  private readonly author: string;
  private defaultDepth: number;
  private timedSearchDepth: number;
  private moveOverheadMs: number;
  private policyOrdering: boolean;
  private policyOrderingWeight: number;
  private chess = new Chess();
  private quit = false;
  private pendingPonder: SearchResult | null = null;
  private pendingPonderElapsedMs = 0;

  constructor(options: UciSessionOptions = {}) {
    this.name = options.name ?? ENGINE_NAME;
    this.author = options.author ?? ENGINE_AUTHOR;
    this.defaultDepth = clampInt(options.defaultDepth ?? 4, 1, 64);
    this.timedSearchDepth = clampInt(options.timedSearchDepth ?? 64, 1, 128);
    this.moveOverheadMs = clampInt(options.moveOverheadMs ?? 50, 0, 5000);
    this.policyOrdering = options.policyOrdering ?? true;
    this.policyOrderingWeight = clampInt(options.policyOrderingWeight ?? 1000, 0, 100000);
  }

  get quitRequested(): boolean {
    return this.quit;
  }

  fen(): string {
    return this.chess.fen();
  }

  processLine(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const tokens = trimmed.split(/\s+/);
    const command = tokens[0]!;

    try {
      switch (command) {
        case "uci":
          return this.uciHandshake();
        case "debug":
          return [];
        case "isready":
          return ["readyok"];
        case "setoption":
          return this.setOption(tokens);
        case "ucinewgame":
          this.chess = new Chess();
          return [];
        case "position":
          this.chess = parsePosition(tokens);
          return [];
        case "go":
          return this.go(tokens);
        case "stop":
          return this.flushPendingPonder();
        case "ponderhit":
          return this.flushPendingPonder();
        case "quit":
          this.quit = true;
          return [];
        default:
          return [`info string unsupported command: ${command}`];
      }
    } catch (error) {
      return [`info string ${errorMessage(error)}`];
    }
  }

  private uciHandshake(): string[] {
    return [
      `id name ${this.name}`,
      `id author ${this.author}`,
      `option name Default Depth type spin default ${this.defaultDepth} min 1 max 64`,
      `option name Move Overhead type spin default ${this.moveOverheadMs} min 0 max 5000`,
      "option name MultiPV type spin default 1 min 1 max 32",
      `option name Policy Ordering type check default ${this.policyOrdering}`,
      `option name Policy Ordering Weight type spin default ${this.policyOrderingWeight} min 0 max 100000`,
      "uciok",
    ];
  }

  private setOption(tokens: string[]): string[] {
    const nameIndex = tokens.indexOf("name");
    if (nameIndex < 0) return ["info string setoption missing name"];

    const valueIndex = tokens.indexOf("value");
    const nameEnd = valueIndex > nameIndex ? valueIndex : tokens.length;
    const name = tokens.slice(nameIndex + 1, nameEnd).join(" ").toLowerCase();
    const value = valueIndex >= 0 ? tokens.slice(valueIndex + 1).join(" ") : "";

    if (name === "default depth") {
      this.defaultDepth = clampInt(parseRequiredInt(value, "Default Depth"), 1, 64);
      return [];
    }

    if (name === "move overhead") {
      this.moveOverheadMs = clampInt(parseRequiredInt(value, "Move Overhead"), 0, 5000);
      return [];
    }

    if (name === "policy ordering") {
      this.policyOrdering = parseBoolean(value, "Policy Ordering");
      return [];
    }

    if (name === "policy ordering weight") {
      this.policyOrderingWeight = clampInt(parseRequiredInt(value, "Policy Ordering Weight"), 0, 100000);
      return [];
    }

    return [`info string unsupported option: ${name}`];
  }

  private go(tokens: string[]): string[] {
    const options = this.parseGoOptions(tokens);
    const started = Date.now();
    const result = search(this.chess.fen(), options);
    const elapsedMs = Date.now() - started;
    if (options.ponder) {
      this.pendingPonder = result;
      this.pendingPonderElapsedMs = elapsedMs;
      return formatInfo(result, elapsedMs);
    }
    return [...formatInfo(result, elapsedMs), `bestmove ${result.bestMove?.uci ?? "0000"}`];
  }

  private parseGoOptions(tokens: string[]): GoOptions {
    let depth: number | undefined;
    const tc: TimeControl = {};
    let infinite = false;
    let ponder = false;

    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      switch (token) {
        case "depth":
          depth = parseOptionalInt(tokens[++i], "depth");
          break;
        case "movetime":
          tc.movetime = parseOptionalInt(tokens[++i], "movetime");
          break;
        case "nodes":
          tc.nodes = parseOptionalInt(tokens[++i], "nodes");
          break;
        case "mate":
          tc.mate = parseOptionalInt(tokens[++i], "mate");
          break;
        case "wtime":
          tc.wtime = parseOptionalInt(tokens[++i], "wtime");
          break;
        case "btime":
          tc.btime = parseOptionalInt(tokens[++i], "btime");
          break;
        case "winc":
          tc.winc = parseOptionalInt(tokens[++i], "winc");
          break;
        case "binc":
          tc.binc = parseOptionalInt(tokens[++i], "binc");
          break;
        case "movestogo":
          tc.movestogo = parseOptionalInt(tokens[++i], "movestogo");
          break;
        case "infinite":
          infinite = true;
          break;
        case "ponder":
          ponder = true;
          break;
        case "searchmoves":
          tc.searchmoves = readSearchMoves(tokens, i + 1);
          i += tc.searchmoves.length;
          break;
        default:
          break;
      }
    }

    const maxTimeMs = infinite || ponder ? undefined : allocateTimeMs(this.chess, tc, this.moveOverheadMs);
    return {
      depth: depth ?? (tc.mate !== undefined ? Math.max(1, tc.mate * 2 - 1) : maxTimeMs !== undefined ? this.timedSearchDepth : this.defaultDepth),
      maxTimeMs,
      maxNodes: tc.nodes,
      searchMoves: tc.searchmoves,
      policyOrdering: this.policyOrdering,
      policyOrderingWeight: this.policyOrderingWeight,
      infinite,
      ponder,
    };
  }

  private flushPendingPonder(): string[] {
    if (!this.pendingPonder) return [];
    const result = this.pendingPonder;
    const elapsedMs = this.pendingPonderElapsedMs;
    this.pendingPonder = null;
    this.pendingPonderElapsedMs = 0;
    return [...formatInfo(result, elapsedMs), `bestmove ${result.bestMove?.uci ?? "0000"}`];
  }
}

function parsePosition(tokens: string[]): Chess {
  if (tokens[1] === STARTPOS) {
    const chess = new Chess();
    const movesIndex = tokens.indexOf(MOVES, 2);
    applyMoves(chess, movesIndex >= 0 ? tokens.slice(movesIndex + 1) : []);
    return chess;
  }

  if (tokens[1] === FEN) {
    const movesIndex = tokens.indexOf(MOVES, 2);
    const fenParts = tokens.slice(2, movesIndex >= 0 ? movesIndex : tokens.length);
    if (fenParts.length < 4) throw new Error("position fen requires at least 4 FEN fields");
    const chess = new Chess(fenParts.join(" "));
    applyMoves(chess, movesIndex >= 0 ? tokens.slice(movesIndex + 1) : []);
    return chess;
  }

  throw new Error("position must use startpos or fen");
}

function applyMoves(chess: Chess, moves: string[]): void {
  for (const move of moves) {
    const normalized = move.trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)) {
      throw new Error(`invalid UCI move: ${move}`);
    }

    const applied = chess.move({
      from: normalized.slice(0, 2),
      to: normalized.slice(2, 4),
      promotion: normalized[4] as PieceSymbol | undefined,
    });
    if (!applied) throw new Error(`illegal UCI move: ${move}`);
  }
}

function formatInfo(result: SearchResult, elapsedMs: number): string[] {
  const time = Math.max(1, elapsedMs);
  const nps = Math.round((result.nodes * 1000) / time);
  const base = `depth ${result.depth} seldepth ${result.seldepth} time ${time} nodes ${result.nodes} nps ${nps} hashfull ${result.hashfull}`;
  if (result.multiPv.length > 0) {
    return result.multiPv.map((line, index) => {
      const pv = line.pv.length > 0 ? ` pv ${line.pv.join(" ")}` : ` pv ${line.move.uci}`;
      return `info ${base} multipv ${index + 1} ${formatScore(line)}${pv}`;
    });
  }
  const pv = result.pv.length > 0 ? ` pv ${result.pv.join(" ")}` : "";
  return [`info ${base} multipv 1 ${formatScore(result)}${pv}`];
}

function formatScore(result: Pick<SearchResult, "mate" | "scoreCp">): string {
  if (typeof result.mate === "number") {
    const sign = result.mate < 0 ? -1 : 1;
    const moves = Math.ceil(Math.abs(result.mate) / 2);
    return `score mate ${sign * moves}`;
  }
  return `score cp ${Math.trunc(result.scoreCp)}`;
}

function allocateTimeMs(
  chess: Chess,
  tc: TimeControl,
  moveOverheadMs: number,
): number | undefined {
  if (tc.movetime !== undefined) return Math.max(1, tc.movetime - moveOverheadMs);

  const sideToMove = chess.turn();
  const remaining = sideToMove === "w" ? tc.wtime : tc.btime;
  if (remaining === undefined) return undefined;

  const increment = sideToMove === "w" ? tc.winc ?? 0 : tc.binc ?? 0;
  const phase = phaseLabel(chess);
  const phaseDefault = phase === "opening" ? 40 : phase === "middlegame" ? 30 : 24;
  const movesToGo = Math.max(1, tc.movestogo ?? phaseDefault);
  const available = Math.max(1, remaining - moveOverheadMs);
  const volatility = chess.inCheck() ? 1.25 : 1;
  const budget = Math.floor((available / movesToGo + increment * 0.75) * volatility);
  return clampInt(budget, 1, available);
}

function readSearchMoves(tokens: string[], start: number): string[] {
  const moves: string[] = [];
  let i = start;
  while (i < tokens.length && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(tokens[i]!)) {
    moves.push(tokens[i]!.toLowerCase());
    i++;
  }
  return moves;
}

function parseRequiredInt(value: string, label: string): number {
  if (!value) throw new Error(`${label} requires a value`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function parseOptionalInt(value: string | undefined, label: string): number {
  if (value === undefined) throw new Error(`go ${label} requires a value`);
  return parseRequiredInt(value, `go ${label}`);
}

function parseBoolean(value: string, label: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
