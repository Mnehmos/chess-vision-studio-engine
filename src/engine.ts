import { Chess } from "chess.js";
import { rankMoves, topCandidates } from "./policy/policyEngine.js";
import { DEFAULT_POLICY_WEIGHTS, type PolicyWeights } from "./policy/weights.js";
import { Searcher, type SearchOptions } from "./search/searchEngine.js";
import { evaluate, evaluateWhite } from "./value/valueEngine.js";
import { DEFAULT_VALUE_WEIGHTS, type ValueWeights } from "./value/weights.js";
import { DEFAULT_RUNG2_WEIGHTS, type Rung2Weights } from "./value/rung2.js";
import type { AnalysisResult, CandidateMove, EngineMove } from "./types.js";

export interface CvsEngineOptions {
  /** Policy weight vector (default: the CVS-Policy-0 hand-tuned baseline). */
  weights?: PolicyWeights;
  /** Softmax temperature for the policy head. */
  temperature?: number;
  /**
   * Value-head weights driving the search leaves and static eval. Omit to use
   * the handcrafted defaults (and the default Searcher, byte-identical play).
   */
  valueWeights?: ValueWeights;
  /**
   * Rung-2 positional feature weights. Omit (or pass all-zero) to keep the eval
   * byte-identical to the handcrafted baseline. When supplied, they drive the
   * search leaves and static eval alongside valueWeights.
   */
  rung2Weights?: Rung2Weights;
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
  private readonly valueWeights: ValueWeights;
  private readonly rung2Weights: Rung2Weights;
  private readonly searcher: Searcher;

  constructor(options: CvsEngineOptions = {}) {
    this.weights = options.weights ?? DEFAULT_POLICY_WEIGHTS;
    this.temperature = options.temperature ?? 1;
    this.valueWeights = options.valueWeights ?? DEFAULT_VALUE_WEIGHTS;
    this.rung2Weights = options.rung2Weights ?? DEFAULT_RUNG2_WEIGHTS;
    // Only inject a custom leaf evaluator when non-default value OR rung-2 weights
    // are supplied, so the default engine keeps byte-identical search behavior.
    this.searcher =
      options.valueWeights || options.rung2Weights
        ? new Searcher((c) => evaluate(c, this.valueWeights, this.rung2Weights))
        : new Searcher();
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
    return evaluateWhite(new Chess(fen), this.valueWeights, this.rung2Weights);
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
