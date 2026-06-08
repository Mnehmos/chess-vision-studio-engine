// A minimal UCI protocol shim for CvsEngine.
//
// CvsEngine searches synchronously, so `go` computes and returns `bestmove`
// immediately — which every UCI GUI (cutechess-cli, lichess-bot, Arena, the
// XBoard/UCI bridges) accepts. This makes CVS-Policy-0 a drop-in UCI engine
// for offline tournaments and for the official Python lichess-bot bridge.
//
// The protocol logic lives in a pure, testable UciSession (output as returned
// strings, no I/O); bin/cvs-engine.ts wires it to stdin/stdout.
import { Chess } from "chess.js";
import { CvsEngine } from "./engine.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface UciOptions {
  /** Search depth used when `go` carries no depth/movetime/clock. Default 4. */
  defaultDepth?: number;
  /** Fraction of the side-to-move's remaining clock to spend on one move. Default 1/30. */
  clockFraction?: number;
  /** Clamp on a clock-derived move budget, ms. Default [50, 2000]. */
  minMoveMs?: number;
  maxMoveMs?: number;
}

export interface UciResult {
  /** Lines to print back to the GUI (already without trailing newlines). */
  out: string[];
  /** True after `quit` — the runner should close. */
  quit?: boolean;
}

function uciToMove(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci.slice(4, 5) : undefined };
}

/** One UCI session: holds the current position and answers protocol lines. */
export class UciSession {
  private chess = new Chess();
  private readonly engine: CvsEngine;
  private readonly defaultDepth: number;
  private readonly clockFraction: number;
  private readonly minMoveMs: number;
  private readonly maxMoveMs: number;

  constructor(engine: CvsEngine = new CvsEngine(), opts: UciOptions = {}) {
    this.engine = engine;
    this.defaultDepth = opts.defaultDepth ?? 4;
    this.clockFraction = opts.clockFraction ?? 1 / 30;
    this.minMoveMs = opts.minMoveMs ?? 50;
    this.maxMoveMs = opts.maxMoveMs ?? 2000;
  }

  /** Handle one line of UCI input; returns the lines to emit (may be empty). */
  handle(line: string): UciResult {
    const trimmed = line.trim();
    if (!trimmed) return { out: [] };
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    switch (cmd) {
      case "uci":
        return { out: ["id name CVS-Policy-0", "id author Chess Vision Studio", "uciok"] };
      case "isready":
        return { out: ["readyok"] };
      case "ucinewgame":
        this.chess = new Chess();
        return { out: [] };
      case "position":
        this.setPosition(args);
        return { out: [] };
      case "go":
        return { out: [this.go(args)] };
      case "stop":
        return { out: [this.bestmoveLine({ depth: this.defaultDepth })] };
      case "ponderhit":
        return { out: [] };
      case "quit":
        return { out: [], quit: true };
      default:
        // setoption / debug / register / unknown — silently accepted.
        return { out: [] };
    }
  }

  private setPosition(args: string[]): void {
    const movesIdx = args.indexOf("moves");
    const head = movesIdx === -1 ? args : args.slice(0, movesIdx);
    if (head[0] === "startpos") {
      this.chess = new Chess();
    } else if (head[0] === "fen") {
      const fen = head.slice(1).join(" ").trim();
      try {
        this.chess = new Chess(fen || START_FEN);
      } catch {
        this.chess = new Chess();
      }
    }
    if (movesIdx !== -1) {
      for (const uci of args.slice(movesIdx + 1)) {
        try {
          const m = this.chess.move(uciToMove(uci));
          if (!m) break;
        } catch {
          break; // a malformed/illegal move from the GUI — stop applying.
        }
      }
    }
  }

  private go(args: string[]): string {
    const opts: { depth?: number; maxTimeMs?: number } = {};
    const side = this.chess.turn(); // 'w' | 'b'
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      if (tok === "depth") opts.depth = Number(args[++i]);
      else if (tok === "movetime") opts.maxTimeMs = Number(args[++i]);
      else if (tok === "wtime" || tok === "btime") {
        const ms = Number(args[++i]);
        const forUs = (tok === "wtime" && side === "w") || (tok === "btime" && side === "b");
        if (forUs && Number.isFinite(ms)) {
          opts.maxTimeMs = Math.max(this.minMoveMs, Math.min(this.maxMoveMs, Math.floor(ms * this.clockFraction)));
        }
      } else if (tok === "infinite") {
        opts.depth = this.defaultDepth; // we don't ponder; treat as fixed-depth.
      }
      // winc/binc/movestogo/nodes/mate are accepted but not used.
    }
    if (opts.depth == null && opts.maxTimeMs == null) opts.depth = this.defaultDepth;
    return this.bestmoveLine(opts);
  }

  private bestmoveLine(opts: { depth?: number; maxTimeMs?: number }): string {
    if (this.chess.isGameOver()) return "bestmove (none)";
    const best = this.engine.bestMove(this.chess.fen(), opts);
    return best ? `bestmove ${best.uci}` : "bestmove (none)";
  }
}
