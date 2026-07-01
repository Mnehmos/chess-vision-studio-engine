import { Chess } from "../chess.js";
import type { TrainingPosition } from "../types.js";
import { evaluateClassicalTerms, type ClassicalTermBreakdown } from "../value/classicalTerms.js";
import { trainPolicy, type TrainOptions, type TrainResult } from "../policy/train.js";

export type ParameterVector = Record<string, number>;

export interface ParameterSpec {
  name: string;
  initial: number;
  min?: number;
  max?: number;
  step: number;
}

export interface TuningOptions {
  iterations?: number;
  minimize?: boolean;
}

export interface TuningHistoryEntry {
  iteration: number;
  parameter: string;
  value: number;
  score: number;
}

export interface TuningResult {
  parameters: ParameterVector;
  score: number;
  history: TuningHistoryEntry[];
}

export interface EvaluationTuningResult extends TuningResult {
  examples: number;
}

const EVAL_TERM_KEYS: (keyof ClassicalTermBreakdown)[] = [
  "pawnStructure",
  "kingSafety",
  "mobility",
  "filesAndRanks",
  "minorPieces",
  "space",
  "center",
];

export function tuneParameters(
  specs: ParameterSpec[],
  objective: (parameters: ParameterVector) => number,
  options: TuningOptions = {},
): TuningResult {
  const minimize = options.minimize ?? false;
  const better = (a: number, b: number) => (minimize ? a < b : a > b);
  const parameters = Object.fromEntries(specs.map((spec) => [spec.name, clamp(spec.initial, spec)]));
  let score = objective(parameters);
  const history: TuningHistoryEntry[] = [];
  const iterations = options.iterations ?? 10;

  for (let iteration = 0; iteration < iterations; iteration++) {
    let improved = false;
    for (const spec of specs) {
      const current = parameters[spec.name]!;
      let bestValue = current;
      let bestScore = score;
      for (const direction of [1, -1]) {
        const candidateValue = clamp(current + spec.step * direction, spec);
        if (candidateValue === current) continue;
        const candidate = { ...parameters, [spec.name]: candidateValue };
        const candidateScore = objective(candidate);
        if (better(candidateScore, bestScore)) {
          bestScore = candidateScore;
          bestValue = candidateValue;
        }
      }
      if (bestValue !== current) {
        parameters[spec.name] = bestValue;
        score = bestScore;
        improved = true;
        history.push({ iteration, parameter: spec.name, value: bestValue, score });
      }
    }
    if (!improved) break;
  }

  return { parameters, score, history };
}

export function tunePolicyWeights(
  positions: TrainingPosition[],
  options: TrainOptions = {},
): TrainResult {
  return trainPolicy(positions, options);
}

export function tuneEvaluationWeights(
  positions: TrainingPosition[],
  specs = defaultEvaluationParameterSpecs(),
  options: TuningOptions = {},
): EvaluationTuningResult {
  const examples = positions.filter((position) => typeof position.evalBefore === "number");
  const result = tuneParameters(
    specs,
    (parameters) => -meanSquaredEvalError(examples, parameters),
    { ...options, minimize: false },
  );
  return { ...result, examples: examples.length };
}

export function defaultEvaluationParameterSpecs(): ParameterSpec[] {
  return EVAL_TERM_KEYS.map((name) => ({
    name,
    initial: 1,
    min: -4,
    max: 4,
    step: 0.25,
  }));
}

function meanSquaredEvalError(positions: TrainingPosition[], parameters: ParameterVector): number {
  if (positions.length === 0) return 0;
  let total = 0;
  for (const position of positions) {
    const terms = evaluateClassicalTerms(new Chess(position.fen));
    const predicted = EVAL_TERM_KEYS.reduce((sum, key) => sum + terms[key] * (parameters[key] ?? 1), 0);
    const error = predicted - position.evalBefore!;
    total += error * error;
  }
  return total / positions.length;
}

function clamp(value: number, spec: ParameterSpec): number {
  return Math.min(spec.max ?? Number.POSITIVE_INFINITY, Math.max(spec.min ?? Number.NEGATIVE_INFINITY, value));
}
