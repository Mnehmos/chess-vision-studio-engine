/**
 * @cvs/engine — Chess Vision Studio Engine.
 *
 * A feature-driven classical chess engine split into three heads:
 *   - policy  (src/policy)   — ranks legal moves into a probability distribution,
 *   - value   (src/value)    — scores positions in centipawns,
 *   - search  (src/search)   — negamax + quiescence that looks ahead.
 *
 * {@link CvsEngine} composes all three. The benchmark + dataset utilities turn
 * CVS analysis exports into labelled tuning data and measure the engine
 * against a reference (top-1/top-k match, cpLoss, mate detection).
 */

export * from "./types.js";
export * from "./constants.js";

export { CvsEngine } from "./engine.js";
export type { AnalyzeOptions, CvsEngineOptions, EngineSearchOptions, SearchCore } from "./engine.js";

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
  evaluateSearch,
  evaluateWhite,
  evaluateWhiteSearch,
  phaseLabel,
  phaseUnits,
  sideSign,
} from "./value/valueEngine.js";
export {
  classicalTermTotal,
  evaluateClassicalTerms,
  scaleEndgameScore,
} from "./value/classicalTerms.js";
export type { ClassicalTermBreakdown } from "./value/classicalTerms.js";
export { createEvaluationState, updateEvaluationState } from "./value/incremental.js";
export type { EvaluationState } from "./value/incremental.js";

// Search head
export { Searcher, search } from "./search/searchEngine.js";
export type { SearchOptions, SearchResult } from "./search/searchEngine.js";
export { runRustSearch, rustCoreBinaryPath } from "./rust/core.js";

// UCI protocol
export { UciSession } from "./uci.js";
export type { UciSessionOptions } from "./uci.js";

// Features
export { see } from "./features/see.js";
export {
  computeMoveFeatures,
  featuresForAllMoves,
} from "./features/moveFeatures.js";
export { extractPositionFeatures } from "./features/positionFeatures.js";
export { detectMotifs, MOTIF_TAXONOMY, normalizeMotif, SUPPORTED_MOTIFS } from "./features/motifs.js";

// Benchmark + dataset
export { benchmark, runReferenceBenchmark } from "./benchmark/metrics.js";
export type {
  BenchmarkOptions,
  BenchmarkReport,
  ReferenceBenchmarkReport,
  ReferenceBenchmarkRow,
} from "./benchmark/metrics.js";
export { BUILTIN_PERFT_CASES, perft, runPerft } from "./benchmark/perft.js";
export type { PerftCase, PerftReport, PerftRow } from "./benchmark/perft.js";
export {
  BUILTIN_SPEED_CASES,
  DEFAULT_SPEED_TARGET_NPS,
  runSpeedBenchmark,
} from "./benchmark/speed.js";
export type {
  SpeedBenchmarkOptions,
  SpeedBenchmarkReport,
  SpeedBenchmarkRow,
  SpeedCase,
} from "./benchmark/speed.js";
export {
  loadBenchmarkSuite,
  loadPerftCases,
  runBenchmarkSuite,
  runBenchmarkSuiteFile,
} from "./benchmark/orchestrator.js";
export type {
  BenchmarkJobConfig,
  BenchmarkJobReport,
  BenchmarkRunOptions,
  BenchmarkSuiteConfig,
  BenchmarkSuiteManifest,
  BenchmarkSuiteReport,
} from "./benchmark/orchestrator.js";
export {
  auditDataset,
  canonicalMove,
  checksumDataset,
  checksumText,
  checksumValue,
  createEnvironment,
  normalizedFenKey,
  positionBuckets,
} from "./benchmark/manifest.js";
export type {
  BenchmarkBuckets,
  BenchmarkEnvironment,
  DatasetAuditIssue,
  DatasetAuditReport,
  DatasetManifest,
  DatasetManifestOptions,
} from "./benchmark/manifest.js";
export { summarizeElo, runSprt, scoreRateToElo, eloToScoreRate } from "./benchmark/stats.js";
export type { EloEstimate, GameTally, SprtConfig, SprtReport } from "./benchmark/stats.js";
export { summarizeGauntlet } from "./benchmark/gauntlet.js";
export type { GauntletConfig, GauntletGame, GauntletReport } from "./benchmark/gauntlet.js";
export { evaluateReleaseGates } from "./benchmark/gates.js";
export type { ReleaseGateConfig, ReleaseGateReport, ReleaseGateResult } from "./benchmark/gates.js";
export {
  defaultEvaluationParameterSpecs,
  tuneEvaluationWeights,
  tuneParameters,
  tunePolicyWeights,
} from "./benchmark/tuning.js";
export type {
  EvaluationTuningResult,
  ParameterSpec,
  ParameterVector,
  TuningHistoryEntry,
  TuningOptions,
  TuningResult,
} from "./benchmark/tuning.js";
export {
  parseJsonl,
  stringifyJsonl,
  loadDataset,
  saveDataset,
  buildTrainingPosition,
  buildMoveRows,
} from "./benchmark/dataset.js";
export type { BuildExampleOptions } from "./benchmark/dataset.js";
