import { Chess } from "chess.js";
import { rankMoves, topCandidates } from "./policy/policyEngine.js";
import { DEFAULT_POLICY_WEIGHTS, type PolicyWeights } from "./policy/weights.js";
import { Searcher, type SearchOptions } from "./search/searchEngine.js";
import { evaluateWhite } from "./value/valueEngine.js";
import type { AnalysisResult, CandidateMove, EngineMove } from "./types.js";

export interface CvsEngineOptions {
  /** Policy weight vector (default: the CVS-Policy-0 hand-tuned baseline). */
  weights?: PolicyWeights;
  /** Softmax temperature for the policy head. */
  temperature?: number;
}

export interface AnalyzeOptions extends SearchOptions {
  /** Number of policy candidates to attach to the result. Default 5. */
  candidates?: number;
}

/**
 * CvsEngine ties the three heads together:
 *   - policy  — proposes ranked candidate moves (what looks promising),
 *   - value   — scores positions in centipawns (who is better),
 *   - search  — looks ahead with policy ordering and value leaves to pick a move.
 *
 * This is the CVS-Policy-0 reference engine the roadmap describes: usable for
 * move prediction (policy only) or full play (search-backed best move).
 */
export class CvsEngine {
  private readonly weights: PolicyWeights;
  private readonly temperature: number;
  private readonly searcher = new Searcher();

  constructor(options: CvsEngineOptions = {}) {
    this.weights = options.weights ?? DEFAULT_POLICY_WEIGHTS;
    this.temperature = options.temperature ?? 1;
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
  bestMove(fen: string, options: SearchOptions = {}): EngineMove | null {
    return this.searcher.search(fen, options).bestMove;
  }

  /** Full analysis: search result + policy candidates + static eval. */
  analyze(fen: string, options: AnalyzeOptions = {}): AnalysisResult {
    const searchResult = this.searcher.search(fen, options);
    const policy = this.predict(fen, options.candidates ?? 5);
    return {
      fen,
      bestMove: searchResult.bestMove,
      scoreCp: searchResult.scoreCp,
      mate: searchResult.mate,
      pv: searchResult.pv,
      depth: searchResult.depth,
      nodes: searchResult.nodes,
      staticEval: this.evaluate(fen),
      policy,
    };
  }
}
