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
  phaseLabel,
  phaseUnits,
  sideSign,
} from "./value/valueEngine.js";

// Search head
export { Searcher, search } from "./search/searchEngine.js";
export type { SearchOptions, SearchResult } from "./search/searchEngine.js";

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
