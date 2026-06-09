/**
 * @cvs/engine — Chess Vision Studio Engine.
 *
 * A feature-driven chess engine split into the three heads from the roadmap:
 *   - policy  (src/policy)   — ranks legal moves into a probability distribution,
 *   - value   (src/value)    — scores positions in centipawns,
 *   - search  (src/search)   — negamax + quiescence that looks ahead.
 *
 * {@link CvsEngine} composes all three. The benchmark + dataset utilities turn
 * CVS analysis exports into supervised training data and measure the engine
 * against a reference (top-1/top-k match, cpLoss, mate detection).
 */

export * from "./types.js";
export * from "./constants.js";

export { CvsEngine } from "./engine.js";
export type { CvsEngineOptions, AnalyzeOptions } from "./engine.js";

// Policy head
export { rankMoves, topCandidates } from "./policy/policyEngine.js";
export type { PolicyOptions } from "./policy/policyEngine.js";
export {
  DEFAULT_POLICY_WEIGHTS,
  FEATURE_SCALE,
  scaledVector,
  scoreFeatures,
} from "./policy/weights.js";
export type { PolicyWeights } from "./policy/weights.js";
export { trainPolicy } from "./policy/train.js";
export type {
  TrainOptions,
  TrainResult,
  TrainHistoryEntry,
} from "./policy/train.js";

// Value head
export {
  evaluate,
  evaluateWhite,
  evaluateWhiteFloat,
  phaseLabel,
  phaseUnits,
  sideSign,
} from "./value/valueEngine.js";
export {
  DEFAULT_VALUE_WEIGHTS,
  VALUE_WEIGHT_KEYS,
  flattenValueWeights,
  unflattenValueWeights,
} from "./value/weights.js";
export type { ValueWeights, MaterialPiece } from "./value/weights.js";
export { trainValue, buildValueExamples } from "./value/train.js";
export type {
  ValueTrainOptions,
  ValueTrainResult,
  ValueTrainHistoryEntry,
} from "./value/train.js";
export { trainValueRanking, buildRankingExamples, preferenceScore } from "./value/trainRanking.js";
export type {
  RankingTrainOptions,
  RankingTrainResult,
  RankingHistoryEntry,
} from "./value/trainRanking.js";
// Rung-2 value features (inert: default weights are 0 → byte-identical eval).
export {
  RUNG2_KEYS,
  DEFAULT_RUNG2_WEIGHTS,
  extractRung2Features,
  rung2Contribution,
  flattenRung2,
  flattenRung2Features,
  unflattenRung2Weights,
} from "./value/rung2.js";
export type { Rung2Key, Rung2Features, Rung2Weights } from "./value/rung2.js";

// Search head
export { Searcher, search } from "./search/searchEngine.js";
export type { SearchOptions, SearchResult, ValueFn } from "./search/searchEngine.js";

// Features
export { see } from "./features/see.js";
export {
  computeMoveFeatures,
  featuresForAllMoves,
} from "./features/moveFeatures.js";
export { extractPositionFeatures } from "./features/positionFeatures.js";

// Benchmark + dataset
export { benchmark } from "./benchmark/metrics.js";
export type { BenchmarkOptions, BenchmarkReport } from "./benchmark/metrics.js";
export {
  parseJsonl,
  stringifyJsonl,
  loadDataset,
  saveDataset,
  buildTrainingPosition,
  buildMoveRows,
} from "./benchmark/dataset.js";
export type { BuildExampleOptions } from "./benchmark/dataset.js";
