import { Chess } from "chess.js";
import type { Move } from "chess.js";
import { MATE_SCORE, MATE_THRESHOLD, PIECE_VALUE } from "../constants.js";
import { evaluate } from "../value/valueEngine.js";
import { seeOnBoard } from "../features/see.js";

/**
 * A leaf evaluation function (side-to-move POV, negamax convention). Injected so
 * trained value weights can drive the search; defaults to the handcrafted
 * {@link evaluate}.
 */
export type ValueFn = (chess: Chess) => number;

const INF = MATE_SCORE * 2;
const MAX_QUIESCENCE_PLY = 64;
// Capped quiet-move quiescence extensions. Quiescence is otherwise capture-only,
// which misses QUIET refutations (a quiet check / mate threat). We extend a small,
// strictly-bounded set of forcing quiet moves near the top of quiescence so the
// search sees them, without exploding: only within the first QUIET_CHECK_MAX_PLY
// quiescence plies, at most MAX_QUIET_CHECKS_PER_NODE per node, and only checks
// that don't simply hang the checking piece (SEE >= 0).
const QUIET_CHECK_MAX_PLY = 2;
const MAX_QUIET_CHECKS_PER_NODE = 3;

export interface SearchOptions {
  /** Maximum search depth in plies (iterative deepening target). Default 4. */
  depth?: number;
  /** Optional wall-clock budget in milliseconds; stops and returns the last completed depth. */
  maxTimeMs?: number;
}

export interface SearchResult {
  bestMove: { san: string; uci: string } | null;
  /** Score in centipawns from the side-to-move's perspective. */
  scoreCp: number;
  /** Signed mate distance in plies when a forced mate is found. */
  mate?: number;
  pv: string[];
  depth: number;
  nodes: number;
  /** Quiescence / forcing-extension telemetry for the whole search. */
  telemetry?: SearchTelemetry;
}

export interface SearchTelemetry {
  /** Quiescence nodes visited. */
  qNodes: number;
  /** Quiescence nodes that added ≥1 forcing quiet extension. */
  quietExtensionNodes: number;
  /** Quiet check moves added to quiescence. */
  checkExtensions: number;
  /** Mate-threat extensions (scaffolded; 0 until that forcing type is implemented). */
  mateThreatExtensions: number;
  /** Hanging-major-piece-threat extensions (scaffolded; 0 until implemented). */
  hangingMajorPieceExtensions: number;
  /** Deepest quiescence ply reached. */
  maxQDepth: number;
  /** Wall-clock for the whole search, ms. */
  elapsedMs: number;
}

type TTFlag = "exact" | "lower" | "upper";

interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  move: { from: string; to: string; promotion?: string } | null;
}

/** MVV-LVA ordering score for a verbose move (captures first, by victim/attacker). */
function captureOrder(move: Move): number {
  const victim = move.captured ? PIECE_VALUE[move.captured] : move.flags.includes("e") ? PIECE_VALUE.p : 0;
  return victim * 16 - PIECE_VALUE[move.piece];
}

/**
 * The search engine: a negamax alpha-beta searcher with iterative deepening, a
 * transposition table, MVV-LVA move ordering and a capture quiescence search.
 * It uses the value engine at the leaves and is the component that turns a
 * static evaluator into something that "looks ahead". A policy ordering can be
 * supplied for the root via {@link SearchOptions} consumers (see engine.ts).
 */
export class Searcher {
  private tt = new Map<string, TTEntry>();
  private nodes = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private aborted = false;
  // Quiescence telemetry (reset per search()).
  private qNodes = 0;
  private quietExtensionNodes = 0;
  private checkExtensions = 0;
  private maxQDepth = 0;

  /**
   * @param evalFn leaf evaluator (side-to-move POV). Defaults to the handcrafted
   * {@link evaluate}; pass a closure over trained value weights to retune search.
   */
  constructor(private readonly evalFn: ValueFn = evaluate) {}

  search(fen: string, options: SearchOptions = {}): SearchResult {
    const maxDepth = Math.max(1, options.depth ?? 4);
    this.tt.clear();
    this.nodes = 0;
    this.aborted = false;
    this.qNodes = 0;
    this.quietExtensionNodes = 0;
    this.checkExtensions = 0;
    this.maxQDepth = 0;
    const startedAt = Date.now();
    this.deadline =
      options.maxTimeMs !== undefined ? Date.now() + options.maxTimeMs : Number.POSITIVE_INFINITY;

    const chess = new Chess(fen);
    let result: SearchResult = {
      bestMove: null,
      scoreCp: this.evalFn(chess),
      pv: [],
      depth: 0,
      nodes: 0,
    };

    for (let depth = 1; depth <= maxDepth; depth++) {
      const score = this.negamax(chess, depth, -INF, INF, 0);
      if (this.aborted) break;

      const rootEntry = this.tt.get(chess.fen());
      const move = rootEntry?.move ?? null;
      result = {
        bestMove: move ? this.describeMove(fen, move) : null,
        scoreCp: score,
        pv: this.extractPv(fen, depth),
        depth,
        nodes: this.nodes,
        ...this.mateField(score),
      };

      // A proven mate cannot be improved by searching deeper.
      if (Math.abs(score) > MATE_THRESHOLD) break;
    }

    result.telemetry = {
      qNodes: this.qNodes,
      quietExtensionNodes: this.quietExtensionNodes,
      checkExtensions: this.checkExtensions,
      mateThreatExtensions: 0, // scaffolded — not yet implemented
      hangingMajorPieceExtensions: 0, // scaffolded — not yet implemented
      maxQDepth: this.maxQDepth,
      elapsedMs: Date.now() - startedAt,
    };
    return result;
  }

  private mateField(score: number): { mate?: number } {
    if (Math.abs(score) <= MATE_THRESHOLD) return {};
    const plies = MATE_SCORE - Math.abs(score);
    return { mate: score > 0 ? plies : -plies };
  }

  private timeUp(): boolean {
    if (this.deadline === Number.POSITIVE_INFINITY) return false;
    if ((this.nodes & 1023) !== 0) return false;
    return Date.now() >= this.deadline;
  }

  private negamax(chess: Chess, depth: number, alphaIn: number, beta: number, ply: number): number {
    if (this.timeUp()) {
      this.aborted = true;
      return this.evalFn(chess);
    }
    this.nodes++;

    if (chess.isCheckmate()) return -MATE_SCORE + ply;
    if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) return 0;
    if (depth <= 0) return this.quiesce(chess, alphaIn, beta, ply);

    const key = chess.fen();
    let alpha = alphaIn;
    const entry = this.tt.get(key);
    if (entry && entry.depth >= depth) {
      if (entry.flag === "exact") return entry.score;
      if (entry.flag === "lower" && entry.score > alpha) alpha = entry.score;
      else if (entry.flag === "upper" && entry.score < beta) beta = entry.score;
      if (alpha >= beta) return entry.score;
    }

    const moves = this.orderMoves(chess, entry?.move ?? null);
    let best = -INF;
    let bestMove: TTEntry["move"] = null;

    for (const move of moves) {
      chess.move({ from: move.from, to: move.to, promotion: move.promotion });
      const score = -this.negamax(chess, depth - 1, -beta, -alpha, ply + 1);
      chess.undo();

      if (this.aborted) return best > -INF ? best : score;

      if (score > best) {
        best = score;
        bestMove = { from: move.from, to: move.to, promotion: move.promotion };
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        this.store(key, depth, best, "lower", bestMove);
        return best;
      }
    }

    const flag: TTFlag = best > alphaIn ? "exact" : "upper";
    this.store(key, depth, best, flag, bestMove);
    return best;
  }

  private quiesce(chess: Chess, alphaIn: number, beta: number, ply: number, qDepth = 0): number {
    if (this.timeUp()) {
      this.aborted = true;
      return this.evalFn(chess);
    }
    this.nodes++;
    this.qNodes++;
    if (qDepth > this.maxQDepth) this.maxQDepth = qDepth;

    const inCheck = chess.inCheck();
    let alpha = alphaIn;

    if (!inCheck) {
      const stand = this.evalFn(chess);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
      if (ply >= MAX_QUIESCENCE_PLY) return stand;
    }

    const all = chess.moves({ verbose: true });
    if (all.length === 0) {
      // No legal moves: checkmate (in check) or stalemate.
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    let moves: Move[];
    if (inCheck) {
      moves = all; // search all evasions
    } else {
      // SEE filtering runs on ONE scratch board parsed once for this node:
      // seeOnBoard mutates + restores placement per call, so we avoid re-parsing
      // the FEN per candidate (the dominant quiescence cost). Castling/ep drift on
      // the throwaway scratch is irrelevant — SEE depends only on placement.
      const scratch = new Chess(chess.fen());
      // Winning/equal captures and promotions...
      moves = all
        .filter(
          (m) =>
            m.flags.includes("c") ||
            m.flags.includes("e") ||
            m.flags.includes("p"),
        )
        .filter((m) => seeOnBoard(scratch, m.from, m.to) >= 0);
      // ...plus a capped set of forcing QUIET moves (checks/mates) near the top of
      // quiescence, so quiet refutations are seen — not only captures.
      if (qDepth < QUIET_CHECK_MAX_PLY) {
        const quietChecks = all
          .filter(
            (m) =>
              !m.flags.includes("c") &&
              !m.flags.includes("e") &&
              !m.flags.includes("p") &&
              (m.san.includes("+") || m.san.includes("#")),
          )
          .filter((m) => seeOnBoard(scratch, m.from, m.to) >= 0)
          .sort((a, b) => captureOrder(b) - captureOrder(a))
          .slice(0, MAX_QUIET_CHECKS_PER_NODE);
        if (quietChecks.length > 0) {
          this.quietExtensionNodes++;
          this.checkExtensions += quietChecks.length;
        }
        moves = [...moves, ...quietChecks];
      }
    }
    moves.sort((a, b) => captureOrder(b) - captureOrder(a));

    let best = inCheck ? -INF : alpha;
    for (const move of moves) {
      chess.move({ from: move.from, to: move.to, promotion: move.promotion });
      const score = -this.quiesce(chess, -beta, -alpha, ply + 1, qDepth + 1);
      chess.undo();
      if (this.aborted) return best;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  private orderMoves(chess: Chess, ttMove: TTEntry["move"]): Move[] {
    const moves = chess.moves({ verbose: true });
    const scoreOf = (m: Move): number => {
      if (ttMove && m.from === ttMove.from && m.to === ttMove.to && m.promotion === ttMove.promotion) {
        return 1e9;
      }
      let s = 0;
      if (m.flags.includes("c") || m.flags.includes("e")) s += 100_000 + captureOrder(m);
      if (m.flags.includes("p")) s += 90_000;
      if (m.san.includes("+") || m.san.includes("#")) s += 5_000;
      return s;
    };
    return moves.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  private store(key: string, depth: number, score: number, flag: TTFlag, move: TTEntry["move"]): void {
    const existing = this.tt.get(key);
    if (existing && existing.depth > depth) return;
    this.tt.set(key, { depth, score, flag, move });
  }

  private describeMove(
    fen: string,
    move: { from: string; to: string; promotion?: string },
  ): { san: string; uci: string } {
    const chess = new Chess(fen);
    const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    return { san: applied.san, uci: applied.lan };
  }

  private extractPv(fen: string, maxLen: number): string[] {
    const chess = new Chess(fen);
    const pv: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < maxLen; i++) {
      const key = chess.fen();
      if (seen.has(key)) break;
      seen.add(key);
      const entry = this.tt.get(key);
      if (!entry || !entry.move) break;
      try {
        const applied = chess.move({
          from: entry.move.from,
          to: entry.move.to,
          promotion: entry.move.promotion,
        });
        pv.push(applied.lan);
      } catch {
        break;
      }
    }
    return pv;
  }
}

/** One-shot search helper. */
export function search(fen: string, options: SearchOptions = {}): SearchResult {
  return new Searcher().search(fen, options);
}
