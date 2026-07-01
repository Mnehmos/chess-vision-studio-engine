import type { MoveFeatures } from "../types.js";
import { MOVE_FEATURE_KEYS } from "../types.js";

export interface PolicyWeights {
  bias: number;
  weights: Record<keyof MoveFeatures, number>;
}

/**
 * Fixed scaling applied to each feature before it meets a weight, so that
 * centipawn-scale features (SEE, capture value, PST delta) and 0/1 indicators
 * all land in roughly the same O(1) range. The same scaling is used for scoring
 * and for tuning, so a tuned weight vector is directly comparable to the
 * hand-tuned default below.
 */
export const FEATURE_SCALE: Record<keyof MoveFeatures, number> = {
  isCapture: 1,
  isCheck: 1,
  isPromotion: 1,
  isCastle: 1,
  isEnPassant: 1,
  see: 0.01,
  captureValue: 0.001,
  escapesAttack: 1,
  movesIntoDanger: 1,
  pstDelta: 0.01,
  develops: 1,
  attacksKingZone: 1,
  movesToCenter: 1,
  createsThreat: 0.5,
};

/**
 * CVS-Policy-0: the hand-tuned baseline weight vector. It encodes ordinary
 * chess priors — reward safe captures and checks, punish moving into danger,
 * value development and central activity — and is the starting point for the
 * tunable linear ranker (see {@link import("./train.js").trainPolicy}).
 */
export const DEFAULT_POLICY_WEIGHTS: PolicyWeights = {
  bias: 0,
  weights: {
    isCapture: 0.2,
    isCheck: 0.3,
    isPromotion: 1.5,
    isCastle: 0.6,
    isEnPassant: 0.1,
    see: 1.0,
    captureValue: 0.3,
    escapesAttack: 0.2,
    movesIntoDanger: -1.5,
    pstDelta: 1.0,
    develops: 0.5,
    attacksKingZone: 0.4,
    movesToCenter: 0.2,
    createsThreat: 0.25,
  },
};

/** Scaled feature vector in the canonical {@link MOVE_FEATURE_KEYS} order. */
export function scaledVector(features: MoveFeatures): number[] {
  return MOVE_FEATURE_KEYS.map((k) => features[k] * FEATURE_SCALE[k]);
}

/** Linear score (logit) of a move under `weights`. */
export function scoreFeatures(features: MoveFeatures, weights: PolicyWeights): number {
  let score = weights.bias;
  for (const k of MOVE_FEATURE_KEYS) {
    score += weights.weights[k] * features[k] * FEATURE_SCALE[k];
  }
  return score;
}
