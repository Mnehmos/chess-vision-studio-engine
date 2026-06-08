import { Chess } from "chess.js";
import type { Square } from "chess.js";
import { computeMoveFeatures } from "../features/moveFeatures.js";
import type { CandidateMove } from "../types.js";
import { DEFAULT_POLICY_WEIGHTS, scoreFeatures, type PolicyWeights } from "./weights.js";

export interface PolicyOptions {
  weights?: PolicyWeights;
  /** Softmax temperature; lower = sharper distribution. Default 1. */
  temperature?: number;
}

function softmax(scores: number[], temperature: number): number[] {
  if (scores.length === 0) return [];
  const t = temperature <= 0 ? 1e-6 : temperature;
  const scaled = scores.map((s) => s / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * The policy engine: score every legal move with the linear feature model and
 * return them as a softmax probability distribution, highest first. This is the
 * "what moves are promising?" head of the engine — it proposes candidates for
 * search and is the basis of the move-prediction benchmark.
 */
export function rankMoves(fen: string, options: PolicyOptions = {}): CandidateMove[] {
  const weights = options.weights ?? DEFAULT_POLICY_WEIGHTS;
  const temperature = options.temperature ?? 1;

  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return [];

  const scored = moves.map((move) => {
    const features = computeMoveFeatures(chess, move);
    return {
      san: move.san,
      uci: move.lan,
      from: move.from as Square,
      to: move.to as Square,
      score: scoreFeatures(features, weights),
      prob: 0,
      features,
    };
  });

  const probs = softmax(
    scored.map((s) => s.score),
    temperature,
  );
  scored.forEach((s, i) => {
    s.prob = probs[i]!;
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Convenience: the top-`k` candidate moves for a position. */
export function topCandidates(fen: string, k = 5, options: PolicyOptions = {}): CandidateMove[] {
  return rankMoves(fen, options).slice(0, k);
}
