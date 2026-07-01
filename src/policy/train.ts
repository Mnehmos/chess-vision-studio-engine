import { featuresForAllMoves } from "../features/moveFeatures.js";
import type { MoveFeatures, TrainingPosition } from "../types.js";
import { MOVE_FEATURE_KEYS } from "../types.js";
import { FEATURE_SCALE, type PolicyWeights } from "./weights.js";

export interface TrainOptions {
  epochs?: number;
  /** Step size for full-batch gradient descent. */
  learningRate?: number;
  /** L2 regularisation strength. */
  l2?: number;
  /** Which move to treat as the positive label. Default "best" (falls back to played). */
  target?: "best" | "played";
}

export interface TrainHistoryEntry {
  epoch: number;
  loss: number;
  top1Accuracy: number;
}

export interface TrainResult {
  weights: PolicyWeights;
  history: TrainHistoryEntry[];
  /** Number of positions actually usable for weight fitting. */
  examples: number;
}

interface Example {
  vectors: number[][]; // one scaled feature vector per legal move
  target: number; // index of the labelled move
}

function scaledVectorOf(features: MoveFeatures): number[] {
  return MOVE_FEATURE_KEYS.map((k) => features[k] * FEATURE_SCALE[k]);
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function buildExamples(positions: TrainingPosition[], target: "best" | "played"): Example[] {
  const examples: Example[] = [];
  for (const pos of positions) {
    const label = (target === "best" ? pos.bestMove : pos.playedMove) ?? pos.playedMove;
    if (!label) continue;
    const rows = featuresForAllMoves(pos.fen);
    if (rows.length < 2) continue;
    const targetIndex = rows.findIndex((r) => r.move.san === label || r.move.lan === label);
    if (targetIndex < 0) continue;
    examples.push({
      vectors: rows.map((r) => scaledVectorOf(r.features)),
      target: targetIndex,
    });
  }
  return examples;
}

/**
 * Fit the policy weight vector with softmax (cross-entropy) ranking: for each
 * position the labelled move is the positive class and the other legal moves are
 * negatives. This is the concrete Phase 3 "candidate move ranker": start from a
 * dataset of {@link TrainingPosition}s with a best/played move and tune weights
 * that put that move on top. The bias term is left untouched because softmax is
 * invariant to a constant logit shift, so it is unidentifiable from ranking.
 */
export function trainPolicy(
  positions: TrainingPosition[],
  options: TrainOptions = {},
): TrainResult {
  const epochs = options.epochs ?? 50;
  const lr = options.learningRate ?? 0.5;
  const l2 = options.l2 ?? 1e-4;
  const examples = buildExamples(positions, options.target ?? "best");

  const numFeatures = MOVE_FEATURE_KEYS.length;
  const w = new Array<number>(numFeatures).fill(0);
  const history: TrainHistoryEntry[] = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array<number>(numFeatures).fill(0);
    let loss = 0;
    let correct = 0;

    for (const ex of examples) {
      const logits = ex.vectors.map((vec) => {
        let z = 0;
        for (let i = 0; i < numFeatures; i++) z += w[i]! * vec[i]!;
        return z;
      });
      const probs = softmax(logits);
      loss += -Math.log(Math.max(probs[ex.target]!, 1e-12));

      let argmax = 0;
      for (let i = 1; i < logits.length; i++) {
        if (logits[i]! > logits[argmax]!) argmax = i;
      }
      if (argmax === ex.target) correct++;

      // dL/dw = sum_i (p_i - y_i) * x_i
      for (let i = 0; i < probs.length; i++) {
        const delta = probs[i]! - (i === ex.target ? 1 : 0);
        const vec = ex.vectors[i]!;
        for (let f = 0; f < numFeatures; f++) grad[f]! += delta * vec[f]!;
      }
    }

    const n = Math.max(examples.length, 1);
    for (let f = 0; f < numFeatures; f++) {
      grad[f] = grad[f]! / n + l2 * w[f]!;
      w[f] = w[f]! - lr * grad[f]!;
    }

    history.push({
      epoch,
      loss: loss / n,
      top1Accuracy: examples.length ? correct / examples.length : 0,
    });
  }

  const weights: PolicyWeights = {
    bias: 0,
    weights: Object.fromEntries(
      MOVE_FEATURE_KEYS.map((k, i) => [k, w[i]!]),
    ) as PolicyWeights["weights"],
  };

  return { weights, history, examples: examples.length };
}
