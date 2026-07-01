import { Chess } from "../chess.js";
import type { Move } from "../chess.js";
import { MATE_SCORE, MATE_THRESHOLD, PIECE_VALUE } from "../constants.js";
import { nullMoveFen } from "../board.js";
import { evaluateSearch } from "../value/valueEngine.js";
import { rankMoves } from "../policy/policyEngine.js";
import { DEFAULT_POLICY_WEIGHTS, type PolicyWeights } from "../policy/weights.js";
import { zobristKey } from "./zobrist.js";

const INF = MATE_SCORE * 2;
const MAX_QUIESCENCE_PLY = 64;

export interface SearchOptions {
  /** Maximum search depth in plies (iterative deepening target). Default 4. */
  depth?: number;
  /** Optional wall-clock budget in milliseconds; stops and returns the last completed depth. */
  maxTimeMs?: number;
  /** Use the policy head as a move-ordering prior. Default true. */
  policyOrdering?: boolean;
  /** Policy weights used for move ordering. Default CVS-Policy-0. */
  policyWeights?: PolicyWeights;
  /** Multiplier applied to policy logits inside the move-order score. Default 1000. */
  policyOrderingWeight?: number;
  /** Include the initial root move order in the result for diagnostics/tests. */
  debugRootMoveOrder?: boolean;
  /** Number of root search alternatives to report. Default 1. */
  multiPv?: number;
  /** Stop after visiting this many nodes. */
  maxNodes?: number;
  /** Restrict root search to these UCI/LAN moves. */
  searchMoves?: string[];
  /** External cooperative stop hook. */
  shouldStop?: () => boolean;
}

export interface SearchPvLine {
  move: { san: string; uci: string };
  scoreCp: number;
  mate?: number;
  pv: string[];
}

export interface SearchResult {
  bestMove: { san: string; uci: string } | null;
  /** Score in centipawns from the side-to-move's perspective. */
  scoreCp: number;
  /** Signed mate distance in plies when a forced mate is found. */
  mate?: number;
  pv: string[];
  multiPv: SearchPvLine[];
  depth: number;
  seldepth: number;
  nodes: number;
  hashfull: number;
  aborted: boolean;
  abortReason?: "time" | "nodes" | "stop";
  /** Initial root move order as UCI/LAN strings, when debugRootMoveOrder is enabled. */
  rootMoveOrder?: string[];
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
  private policyCache = new Map<string, Map<string, number>>();
  private killers: [string | null, string | null][] = [];
  private history = new Map<string, number>();
  private countermoves = new Map<string, string>();
  private nodes = 0;
  private seldepth = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private maxNodes = Number.POSITIVE_INFINITY;
  private shouldStop: (() => boolean) | undefined;
  private aborted = false;
  private abortReason: SearchResult["abortReason"];
  private rootSearchMoves: string[] = [];
  private policyOrdering = true;
  private policyWeights: PolicyWeights = DEFAULT_POLICY_WEIGHTS;
  private policyOrderingWeight = 1000;

  search(fen: string, options: SearchOptions = {}): SearchResult {
    const maxDepth = Math.max(1, options.depth ?? 4);
    this.tt.clear();
    this.policyCache.clear();
    this.killers = [];
    this.history.clear();
    this.countermoves.clear();
    this.nodes = 0;
    this.seldepth = 0;
    this.aborted = false;
    this.abortReason = undefined;
    this.maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
    this.shouldStop = options.shouldStop;
    this.rootSearchMoves = (options.searchMoves ?? []).map((move) => move.toLowerCase());
    this.policyOrdering = options.policyOrdering ?? true;
    this.policyWeights = options.policyWeights ?? DEFAULT_POLICY_WEIGHTS;
    this.policyOrderingWeight = Math.max(0, options.policyOrderingWeight ?? 1000);
    this.deadline =
      options.maxTimeMs !== undefined ? Date.now() + options.maxTimeMs : Number.POSITIVE_INFINITY;

    const chess = new Chess(fen);
    const rootMoveOrder = options.debugRootMoveOrder
      ? this.orderMoves(chess, null).map((move) => move.lan)
      : undefined;
    let result: SearchResult = {
      bestMove: null,
      scoreCp: evaluateSearch(chess),
      pv: [],
      multiPv: [],
      depth: 0,
      seldepth: 0,
      nodes: 0,
      hashfull: 0,
      aborted: false,
      ...(rootMoveOrder ? { rootMoveOrder } : {}),
    };
    let previousScore = result.scoreCp;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const window = depth >= 2 ? 50 : INF;
      let alpha = Math.max(-INF, previousScore - window);
      let beta = Math.min(INF, previousScore + window);
      let score = this.negamax(chess, depth, alpha, beta, 0);
      if (!this.aborted && (score <= alpha || score >= beta)) {
        score = this.negamax(chess, depth, -INF, INF, 0);
      }
      if (this.aborted) break;
      previousScore = score;

      const rootEntry = this.tt.get(this.key(chess));
      const move = rootEntry?.move ?? null;
      result = {
        bestMove: move ? this.describeMove(fen, move) : null,
        scoreCp: score,
        pv: this.extractPv(fen, depth),
        multiPv: [],
        depth,
        seldepth: this.seldepth,
        nodes: this.nodes,
        hashfull: this.hashfull(),
        aborted: false,
        ...(rootMoveOrder ? { rootMoveOrder } : {}),
        ...this.mateField(score),
      };

      if ((options.multiPv ?? 1) > 1) {
        result.multiPv = this.collectMultiPv(fen, depth, options.multiPv ?? 1);
        if (this.aborted) break;
      }

      // A proven mate cannot be improved by searching deeper.
      if (Math.abs(score) > MATE_THRESHOLD) break;
    }

    return {
      ...result,
      nodes: this.nodes,
      seldepth: this.seldepth,
      hashfull: this.hashfull(),
      aborted: this.aborted,
      ...(this.aborted && this.abortReason ? { abortReason: this.abortReason } : {}),
    };
  }

  private mateField(score: number): { mate?: number } {
    if (Math.abs(score) <= MATE_THRESHOLD) return {};
    const plies = MATE_SCORE - Math.abs(score);
    return { mate: score > 0 ? plies : -plies };
  }

  private abortRequested(): boolean {
    if (this.shouldStop?.()) {
      this.abortReason = "stop";
      return true;
    }
    if (this.nodes >= this.maxNodes) {
      this.abortReason = "nodes";
      return true;
    }
    if (this.deadline !== Number.POSITIVE_INFINITY && (this.nodes & 63) === 0 && Date.now() >= this.deadline) {
      this.abortReason = "time";
      return true;
    }
    return false;
  }

  private negamax(
    chess: Chess,
    depth: number,
    alphaIn: number,
    beta: number,
    ply: number,
    previousMove?: string,
    lastMoveTo?: string,
  ): number {
    if (this.abortRequested()) {
      this.aborted = true;
      return evaluateSearch(chess);
    }
    this.nodes++;
    this.seldepth = Math.max(this.seldepth, ply);

    if (chess.isCheckmate()) return -MATE_SCORE + ply;
    if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) return 0;
    if (depth <= 0) return this.quiesce(chess, alphaIn, beta, ply);

    const inCheck = chess.inCheck();
    const key = this.key(chess);
    let alpha = alphaIn;
    const entry = this.tt.get(key);
    if (entry && entry.depth >= depth) {
      if (entry.flag === "exact") return entry.score;
      if (entry.flag === "lower" && entry.score > alpha) alpha = entry.score;
      else if (entry.flag === "upper" && entry.score < beta) beta = entry.score;
      if (alpha >= beta) return entry.score;
    }

    const staticEval = evaluateSearch(chess);
    if (!inCheck && depth <= 2 && staticEval - 120 * depth >= beta) return staticEval;

    if (!inCheck && depth >= 3 && this.hasNonPawnMaterial(chess, chess.turn())) {
      const skippedFen = nullMoveFen(chess.fen());
      if (skippedFen) {
        try {
          const nullScore = -this.negamax(new Chess(skippedFen), depth - 3, -beta, -beta + 1, ply + 1);
          if (this.aborted) return nullScore;
          if (nullScore >= beta) return beta;
        } catch {
          // Some illegal null positions are expected around checks and adjacent kings.
        }
      }
    }

    let moves = this.orderMoves(chess, entry?.move ?? null, ply, previousMove);
    if (ply === 0 && this.rootSearchMoves.length > 0) {
      const allowed = new Set(this.rootSearchMoves);
      moves = moves.filter((move) => allowed.has(move.lan));
    }
    let best = -INF;
    let bestMove: TTEntry["move"] = null;
    let searchedMoves = 0;

    for (const move of moves) {
      const tactical = this.isTactical(move);
      if (!inCheck && depth === 1 && !tactical && staticEval + 160 <= alpha) continue;

      chess.push(move);
      const givesCheck = chess.inCheck();
      const extension = givesCheck || move.to === lastMoveTo ? 1 : 0;
      const childDepth = Math.max(0, depth - 1 + extension);
      const reduction =
        searchedMoves >= 4 && depth >= 3 && !tactical && !givesCheck && extension === 0 ? 1 : 0;
      const keyMove = moveKey(move);
      let score: number;
      if (searchedMoves === 0) {
        score = -this.negamax(chess, childDepth, -beta, -alpha, ply + 1, keyMove, move.to);
      } else {
        score = -this.negamax(chess, Math.max(0, childDepth - reduction), -alpha - 1, -alpha, ply + 1, keyMove, move.to);
        if (!this.aborted && reduction > 0 && score > alpha) {
          score = -this.negamax(chess, childDepth, -alpha - 1, -alpha, ply + 1, keyMove, move.to);
        }
        if (!this.aborted && score > alpha && score < beta) {
          score = -this.negamax(chess, childDepth, -beta, -alpha, ply + 1, keyMove, move.to);
        }
      }
      chess.undo();
      searchedMoves++;

      if (this.aborted) return best > -INF ? best : score;

      if (score > best) {
        best = score;
        bestMove = { from: move.from, to: move.to, promotion: move.promotion };
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (!tactical) this.rememberQuietCutoff(move, depth, ply, previousMove);
        this.store(key, depth, best, "lower", bestMove);
        return best;
      }
    }

    if (searchedMoves === 0) return staticEval;

    const flag: TTFlag = best > alphaIn ? "exact" : "upper";
    this.store(key, depth, best, flag, bestMove);
    return best;
  }

  private quiesce(chess: Chess, alphaIn: number, beta: number, ply: number): number {
    if (this.abortRequested()) {
      this.aborted = true;
      return evaluateSearch(chess);
    }
    this.nodes++;
    this.seldepth = Math.max(this.seldepth, ply);

    const inCheck = chess.inCheck();
    let alpha = alphaIn;

    if (!inCheck) {
      const stand = evaluateSearch(chess);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
      if (ply >= MAX_QUIESCENCE_PLY) return stand;
    }

    const all = chess.moves({ verbose: true, san: false, fen: false });
    if (all.length === 0) {
      // No legal moves: checkmate (in check) or stalemate.
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    let moves: Move[];
    if (inCheck) {
      moves = all; // search all evasions
    } else {
      // Only winning/equal captures and promotions.
      moves = all
        .filter(
          (m) =>
            m.flags.includes("c") ||
            m.flags.includes("e") ||
            m.flags.includes("p"),
        );
    }
    moves.sort((a, b) => captureOrder(b) - captureOrder(a));

    let best = inCheck ? -INF : alpha;
    for (const move of moves) {
      chess.push(move);
      const score = -this.quiesce(chess, -beta, -alpha, ply + 1);
      chess.undo();
      if (this.aborted) return best;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  private orderMoves(chess: Chess, ttMove: TTEntry["move"], ply = 0, previousMove?: string): Move[] {
    const moves = chess.moves({ verbose: true, san: false, fen: false });
    const policyScores = ply === 0 ? this.policyScores(chess.fen()) : new Map<string, number>();
    const killers = this.killers[ply] ?? [null, null];
    const counter = previousMove ? this.countermoves.get(previousMove) : undefined;
    const scoreOf = (m: Move): number => {
      if (ttMove && m.from === ttMove.from && m.to === ttMove.to && m.promotion === ttMove.promotion) {
        return 1e9;
      }
      const key = moveKey(m);
      let s = 0;
      if (m.flags.includes("c") || m.flags.includes("e")) s += 100_000 + captureOrder(m);
      if (m.flags.includes("p")) s += 90_000;
      if (counter && key === counter) s += 80_000;
      if (key === killers[0]) s += 70_000;
      else if (key === killers[1]) s += 69_000;
      s += this.history.get(key) ?? 0;
      s += (policyScores.get(m.lan) ?? 0) * this.policyOrderingWeight;
      return s;
    };
    return moves.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  private collectMultiPv(fen: string, depth: number, count: number): SearchPvLine[] {
    const chess = new Chess(fen);
    const lines: SearchPvLine[] = [];
    for (const move of this.orderMoves(chess, null)) {
      if (this.abortRequested()) {
        this.aborted = true;
        break;
      }
      chess.push(move);
      const score = -this.negamax(chess, Math.max(0, depth - 1), -INF, INF, 1, moveKey(move), move.to);
      const childPv = this.extractPv(chess.fen(), Math.max(0, depth - 1));
      chess.undo();
      const described = this.describeMove(fen, move);
      lines.push({
        move: described,
        scoreCp: score,
        pv: [move.lan, ...childPv],
        ...this.mateField(score),
      });
      if (this.aborted) break;
    }
    return lines.sort((a, b) => b.scoreCp - a.scoreCp).slice(0, Math.max(1, count));
  }

  private policyScores(fen: string): Map<string, number> {
    if (!this.policyOrdering || this.policyOrderingWeight <= 0) return new Map();
    const cached = this.policyCache.get(fen);
    if (cached) return cached;

    const scores = new Map<string, number>();
    for (const candidate of rankMoves(fen, { weights: this.policyWeights })) {
      scores.set(candidate.uci, candidate.score);
    }
    this.policyCache.set(fen, scores);
    return scores;
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
    if (!applied) throw new Error(`Illegal search move: ${move.from}${move.to}${move.promotion ?? ""}`);
    return { san: applied.san, uci: applied.lan };
  }

  private key(chess: Chess): string {
    return zobristKey(chess);
  }

  private hashfull(): number {
    return Math.min(1000, Math.round(this.tt.size / 4));
  }

  private isTactical(move: Move): boolean {
    return move.flags.includes("c") || move.flags.includes("e") || move.flags.includes("p");
  }

  private rememberQuietCutoff(move: Move, depth: number, ply: number, previousMove?: string): void {
    const key = moveKey(move);
    const pair = this.killers[ply] ?? [null, null];
    if (pair[0] !== key) {
      pair[1] = pair[0];
      pair[0] = key;
      this.killers[ply] = pair;
    }
    this.history.set(key, (this.history.get(key) ?? 0) + depth * depth);
    if (previousMove) this.countermoves.set(previousMove, key);
  }

  private hasNonPawnMaterial(chess: Chess, color: "w" | "b"): boolean {
    for (const row of chess.board()) {
      for (const piece of row) {
        if (piece?.color === color && piece.type !== "p" && piece.type !== "k") return true;
      }
    }
    return false;
  }

  private extractPv(fen: string, maxLen: number): string[] {
    const chess = new Chess(fen);
    const pv: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < maxLen; i++) {
      const key = this.key(chess);
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
        if (!applied) break;
        pv.push(applied.lan);
      } catch {
        break;
      }
    }
    return pv;
  }
}

function moveKey(move: Move): string {
  return move.lan;
}

/** One-shot search helper. */
export function search(fen: string, options: SearchOptions = {}): SearchResult {
  return new Searcher().search(fen, options);
}
