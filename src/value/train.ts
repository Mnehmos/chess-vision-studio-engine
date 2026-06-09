// Value-head trainer. Learns the 9-scalar {@link ValueWeights} by REGRESSING the
// handcrafted White-POV evaluation toward a Stockfish position eval, so that the
// alpha-beta search (whose leaves are this value function) produces searched
// moves with lower cpLoss / blunder rate / better mate safety.
//
// The model is LINEAR in the weights, so the gradients are exact (closed-form
// per term) and full-batch gradient descent converges deterministically, exactly
// like {@link trainPolicy}. The weights are seeded to — and L2-regularized toward
// — DEFAULT_VALUE_WEIGHTS, so the handcrafted eval is the prior and training only
// nudges it where the SF labels disagree. Loss is Huber (smooth-L1) in PAWNS,
// robust to SF outliers and mate saturation.
import { Chess } from "chess.js";
import type { TrainingPosition } from "../types.js";
import { positionPartials } from "./partials.js";
import {
  DEFAULT_VALUE_WEIGHTS,
  flattenValueWeights,
  unflattenValueWeights,
  type ValueWeights,
} from "./weights.js";

export interface ValueTrainOptions {
  /** Full-batch gradient descent epochs. Default 200. */
  epochs?: number;
  /** Learning rate. Default 0.05 (small — the seed is already near-optimal). */
  learningRate?: number;
  /** L2 strength, regularized TOWARD the defaults. Default 1e-3. */
  l2?: number;
  /** Huber transition point in PAWNS. Default 1.0. */
  huberDelta?: number;
}

export interface ValueTrainHistoryEntry {
  epoch: number;
  /** Mean Huber loss in pawns. */
  loss: number;
  /** Mean absolute error in pawns. */
  mae: number;
}

export interface ValueTrainResult {
  weights: ValueWeights;
  history: ValueTrainHistoryEntry[];
  examples: number;
}

/** Saturated White-POV cp used for mate labels (well below MATE_SCORE). */
const MATE_SAT_CP = 3000;

/**
 * Precomputed per-position partials. Because the eval is linear in the weights,
 * each weight's contribution and gradient is a fixed coefficient computed once.
 */
interface Example {
  /** cp coefficient per material weight: PIECE_VALUE[t] * (whiteCount - blackCount). */
  matCoef: number[];
  /** cp: sum over pieces of sign * (mg*mgWeight + eg*egWeight). */
  posSum: number;
  /** (+1 if white has the bishop pair) + (-1 if black does). */
  pairInd: number;
  /** +1 white to move, -1 black to move. */
  tempoSign: number;
  /** Regression target, White-POV centipawns. */
  targetCp: number;
}

/** White-POV cp regression target from a row, or undefined if unusable. */
function targetFor(pos: TrainingPosition): number | undefined {
  if (typeof pos.evalBefore === "number") {
    return Math.max(-MATE_SAT_CP, Math.min(MATE_SAT_CP, pos.evalBefore));
  }
  const mate = pos.topMoves?.[0]?.mate;
  if (typeof mate === "number") {
    const stmSign = pos.sideToMove === "w" ? 1 : -1;
    return stmSign * (mate > 0 ? MATE_SAT_CP : -MATE_SAT_CP);
  }
  return undefined;
}

export function buildValueExamples(positions: TrainingPosition[]): Example[] {
  const examples: Example[] = [];
  for (const pos of positions) {
    const targetCp = targetFor(pos);
    if (targetCp === undefined) continue;
    let chess: Chess;
    try {
      chess = new Chess(pos.fen);
    } catch {
      continue;
    }
    const { matCoef, posSum, pairInd, tempoSign } = positionPartials(chess);
    examples.push({ matCoef, posSum, pairInd, tempoSign, targetCp });
  }
  return examples;
}

/** Predicted White-POV cp (float) for the flat weight vector. */
function predictCp(flat: number[], ex: Example): number {
  let s = 0;
  for (let i = 0; i < 5; i++) s += (flat[i] ?? 0) * (ex.matCoef[i] ?? 0);
  s += (flat[5] ?? 0) * ex.posSum;
  s += (flat[6] ?? 0) * ex.pairInd;
  s += (flat[7] ?? 0) * ex.tempoSign;
  return s;
}

/** d(predicted cp)/d(weight), in flat order. */
function partials(ex: Example): number[] {
  return [
    ex.matCoef[0] ?? 0,
    ex.matCoef[1] ?? 0,
    ex.matCoef[2] ?? 0,
    ex.matCoef[3] ?? 0,
    ex.matCoef[4] ?? 0,
    ex.posSum,
    ex.pairInd,
    ex.tempoSign,
  ];
}

export function trainValue(
  positions: TrainingPosition[],
  options: ValueTrainOptions = {},
): ValueTrainResult {
  const epochs = options.epochs ?? 200;
  const lr = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 1e-3;
  const delta = options.huberDelta ?? 1.0; // pawns

  const examples = buildValueExamples(positions);
  const flat = flattenValueWeights(DEFAULT_VALUE_WEIGHTS);
  const def = flattenValueWeights(DEFAULT_VALUE_WEIGHTS);
  const n = Math.max(examples.length, 1);
  const history: ValueTrainHistoryEntry[] = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(flat.length).fill(0);
    let lossSum = 0;
    let maeSum = 0;
    for (const ex of examples) {
      const e = (predictCp(flat, ex) - ex.targetCp) / 100; // residual in pawns
      const ae = Math.abs(e);
      const hPrime = ae <= delta ? e : delta * Math.sign(e); // Huber gradient (pawns)
      lossSum += ae <= delta ? 0.5 * e * e : delta * (ae - 0.5 * delta);
      maeSum += ae;
      const part = partials(ex);
      for (let f = 0; f < flat.length; f++) {
        // d(residual_pawns)/dw = part_cp / 100
        grad[f] += (hPrime * (part[f] ?? 0)) / 100;
      }
    }
    for (let f = 0; f < flat.length; f++) {
      const g = grad[f] / n + l2 * ((flat[f] ?? 0) - (def[f] ?? 0));
      flat[f] = (flat[f] ?? 0) - lr * g;
    }
    history.push({ epoch, loss: lossSum / n, mae: maeSum / n });
  }

  return { weights: unflattenValueWeights(flat), history, examples: examples.length };
}
