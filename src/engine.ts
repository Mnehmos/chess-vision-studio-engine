import { Chess } from "./chess.js";
import { rankMoves, topCandidates } from "./policy/policyEngine.js";
import { DEFAULT_POLICY_WEIGHTS, type PolicyWeights } from "./policy/weights.js";
import { Searcher, type SearchOptions } from "./search/searchEngine.js";
import { runRustSearch } from "./rust/core.js";
import { evaluateWhite } from "./value/valueEngine.js";
import type { AnalysisResult, CandidateMove, EngineMove } from "./types.js";

export type SearchCore = "typescript" | "rust";

export interface CvsEngineOptions {
  /** Policy weight vector (default: the CVS-Policy-0 hand-tuned baseline). */
  weights?: PolicyWeights;
  /** Softmax temperature for the policy head. */
  temperature?: number;
  /** Runtime search backend. TypeScript is the reference core; Rust is the fast native core. */
  searchCore?: SearchCore;
}

export interface EngineSearchOptions extends SearchOptions {
  /** Override the engine's configured search backend for this call. */
  searchCore?: SearchCore;
}

export interface AnalyzeOptions extends EngineSearchOptions {
  /** Number of policy candidates to attach to the result. Default 5. */
  candidates?: number;
}

/**
 * CvsEngine ties the three heads together:
 *   - policy  — proposes ranked candidate moves (what looks promising),
 *   - value   — scores positions in centipawns (who is better),
 *   - search  — looks ahead with policy ordering and value leaves to pick a move.
 *
 * This is the CVS-Policy-0 classical reference engine: usable for
 * move prediction (policy only) or full play (search-backed best move).
 */
export class CvsEngine {
  private readonly weights: PolicyWeights;
  private readonly temperature: number;
  private readonly searchCore: SearchCore;
  private readonly searcher = new Searcher();

  constructor(options: CvsEngineOptions = {}) {
    this.weights = options.weights ?? DEFAULT_POLICY_WEIGHTS;
    this.temperature = options.temperature ?? 1;
    this.searchCore = options.searchCore ?? "typescript";
  }

  /** Policy-only move prediction: the top-`k` candidate moves for a position. */
  predict(fen: string, k = 5): CandidateMove[] {
    return topCandidates(fen, k, { weights: this.weights, temperature: this.temperature });
  }

  /** Full policy probability distribution over all legal moves. */
  policy(fen: string): CandidateMove[] {
    return rankMoves(fen, { weights: this.weights, temperature: this.temperature });
  }

  /** Static value-engine evaluation of `fen`, centipawns from White's perspective. */
  evaluate(fen: string): number {
    return evaluateWhite(new Chess(fen));
  }

  /** Search-backed best move, or null when the position is terminal. */
  bestMove(fen: string, options: EngineSearchOptions = {}): EngineMove | null {
    return this.search(fen, options).bestMove;
  }

  /** Full analysis: search result + policy candidates + static eval. */
  analyze(fen: string, options: AnalyzeOptions = {}): AnalysisResult {
    const searchResult = this.search(fen, options);
    const policy = this.predict(fen, options.candidates ?? 5);
    return {
      fen,
      bestMove: searchResult.bestMove,
      scoreCp: searchResult.scoreCp,
      mate: searchResult.mate,
      pv: searchResult.pv,
      multiPv: searchResult.multiPv,
      depth: searchResult.depth,
      seldepth: searchResult.seldepth,
      nodes: searchResult.nodes,
      hashfull: searchResult.hashfull,
      aborted: searchResult.aborted,
      abortReason: searchResult.abortReason,
      rootMoveOrder: searchResult.rootMoveOrder,
      staticEval: this.evaluate(fen),
      policy,
    };
  }

  private search(fen: string, options: EngineSearchOptions = {}) {
    const { searchCore, ...searchOptions } = options;
    const core = searchCore ?? this.searchCore;
    const resolved = this.searchOptions(searchOptions);
    return core === "rust" ? runRustSearch(fen, resolved) : this.searcher.search(fen, resolved);
  }

  private searchOptions<T extends SearchOptions>(options: T): T {
    return {
      ...options,
      policyWeights: options.policyWeights ?? this.weights,
    };
  }
}
