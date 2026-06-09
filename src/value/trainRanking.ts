// Sibling-ranking value trainer (Phase B). Search does not need the value head
// to match Stockfish's ABSOLUTE eval — it needs the right ORDER over the child
// positions reached after each legal move ("which child is least dangerous?").
//
// For a parent P with candidate moves mᵢ → children Cᵢ and Stockfish cpLoss(mᵢ),
// the parent's negamax preference for mᵢ is
//        preference(mᵢ) = −value(Cᵢ) = parentStmSign · evaluateWhiteFloat(Cᵢ),
// because the search leaf returns the child-side-to-move score and negamax negates
// it. We train a pairwise hinge so the best child outranks each worse child by a
// margin ∝ its cpLoss:
//        loss = Σⱼ max(0, marginScale·cpLossⱼ − (pref(best) − pref(j))).
// evaluateWhiteFloat is LINEAR in the weights, so pref is linear and the hinge
// subgradient is exact — full-batch GD, L2-regularized toward the handcrafted
// defaults, exactly like the regression trainer.
import { Chess } from "chess.js";
import type { Color } from "chess.js";
import type { TrainingPosition } from "../types.js";
import { evaluateWhiteFloat } from "./valueEngine.js";
import { dot, flatPartials, positionPartials } from "./partials.js";
import {
  DEFAULT_VALUE_WEIGHTS,
  flattenValueWeights,
  unflattenValueWeights,
  type ValueWeights,
} from "./weights.js";

export interface RankingTrainOptions {
  /** Full-batch gradient descent epochs. Default 300. */
  epochs?: number;
  /** Learning rate. Default 0.01 (small — sibling coefficients are cp-scale). */
  learningRate?: number;
  /** L2 strength, regularized TOWARD the defaults. Default 1e-3. */
  l2?: number;
  /** Required value gap (cp) per cp of cpLoss. Default 1.0. */
  marginScale?: number;
  /** Max candidate moves per parent to use (best-first). Default 8. */
  topK?: number;
}

export interface RankingHistoryEntry {
  epoch: number;
  /** Mean hinge slack over ranking pairs, in pawns. */
  loss: number;
  /** Fraction of ranking pairs still violating their margin. */
  violationRate: number;
  /** Fraction of parents whose argmax child is Stockfish's best (in-sample). */
  rankAccuracy: number;
}

export interface RankingTrainResult {
  weights: ValueWeights;
  history: RankingHistoryEntry[];
  examples: number; // parents used
  pairs: number; // total ranking pairs
}

/** Saturated cp used for mate-labelled candidates (sign = side-to-move POV). */
const MATE_SAT_CP = 3000;

interface Candidate {
  /** parentStmSign · flatPartials(child); empty when the child is terminal. */
  coef: number[];
  /** Constant preference for a terminal child (else 0). */
  prefConst: number;
  terminal: boolean;
  /** Stockfish cpLoss of this move vs the best (≥ 0, centipawns). */
  cpLoss: number;
}

interface RankingExample {
  best: number; // index of the cpLoss-0 candidate
  candidates: Candidate[];
}

/** Side-to-move-POV cp of a candidate, mapping mate to a saturated cp. */
function effectiveCp(cp: number | undefined, mate: number | undefined): number | null {
  if (typeof mate === "number") return mate > 0 ? MATE_SAT_CP : -MATE_SAT_CP;
  if (typeof cp === "number") return cp;
  return null;
}

/**
 * Negamax-consistent parent preference for the move leading to `child`:
 * `parentStmSign · evaluateWhiteFloat(child)`, which equals `−evaluate(child)`.
 * Exported so the sign convention (the Phase-B landmine) is directly testable.
 */
export function preferenceScore(parentTurn: Color, child: Chess, weights: ValueWeights = DEFAULT_VALUE_WEIGHTS): number {
  const parentSign = parentTurn === "w" ? 1 : -1;
  return parentSign * evaluateWhiteFloat(child, weights);
}

export function buildRankingExamples(positions: TrainingPosition[], topK = 8): RankingExample[] {
  const examples: RankingExample[] = [];
  for (const pos of positions) {
    const tm = pos.topMoves;
    if (!tm || tm.length < 2) continue;
    let parent: Chess;
    try {
      parent = new Chess(pos.fen);
    } catch {
      continue;
    }
    const parentSign = parent.turn() === "w" ? 1 : -1;

    const raw: { coef: number[]; prefConst: number; terminal: boolean; eff: number }[] = [];
    for (const m of tm.slice(0, topK)) {
      const eff = effectiveCp(m.cp, m.mate);
      if (eff === null) continue;
      const child = new Chess(pos.fen);
      let moved: ReturnType<Chess["move"]> | null = null;
      try {
        moved = child.move(m.san);
      } catch {
        moved = null;
      }
      if (!moved && m.uci && m.uci.length >= 4) {
        try {
          moved = child.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci.slice(4) || undefined });
        } catch {
          moved = null;
        }
      }
      if (!moved) continue;
      const terminal =
        child.isCheckmate() || child.isStalemate() || child.isInsufficientMaterial() || child.isDraw();
      const coef = terminal ? [] : flatPartials(positionPartials(child)).map((x) => parentSign * x);
      const prefConst = terminal ? parentSign * evaluateWhiteFloat(child) : 0;
      raw.push({ coef, prefConst, terminal, eff });
    }
    if (raw.length < 2) continue;

    let bestEff = -Infinity;
    for (const r of raw) bestEff = Math.max(bestEff, r.eff);
    let best = 0;
    let bestLoss = Infinity;
    const candidates: Candidate[] = raw.map((r, i) => {
      const cpLoss = bestEff - r.eff;
      if (cpLoss < bestLoss) {
        bestLoss = cpLoss;
        best = i;
      }
      return { coef: r.coef, prefConst: r.prefConst, terminal: r.terminal, cpLoss };
    });
    examples.push({ best, candidates });
  }
  return examples;
}

function prefOf(flat: number[], c: Candidate): number {
  return c.terminal ? c.prefConst : dot(flat, c.coef);
}

export function trainValueRanking(positions: TrainingPosition[], options: RankingTrainOptions = {}): RankingTrainResult {
  const epochs = options.epochs ?? 300;
  const lr = options.learningRate ?? 0.01;
  const l2 = options.l2 ?? 1e-3;
  const marginScale = options.marginScale ?? 1.0;
  const topK = options.topK ?? 8;

  const examples = buildRankingExamples(positions, topK);
  const flat = flattenValueWeights(DEFAULT_VALUE_WEIGHTS);
  const def = flattenValueWeights(DEFAULT_VALUE_WEIGHTS);

  let totalPairs = 0;
  for (const ex of examples) {
    for (let j = 0; j < ex.candidates.length; j++) {
      if (j !== ex.best && marginScale * ex.candidates[j]!.cpLoss > 0) totalPairs++;
    }
  }
  const history: RankingHistoryEntry[] = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array<number>(flat.length).fill(0);
    let lossSum = 0;
    let pairs = 0;
    let violations = 0;
    let correct = 0;
    for (const ex of examples) {
      const prefs = ex.candidates.map((c) => prefOf(flat, c));
      // In-sample ranking accuracy: does the head's argmax child match SF's best?
      let argmax = 0;
      for (let i = 1; i < prefs.length; i++) if (prefs[i]! > prefs[argmax]!) argmax = i;
      if (argmax === ex.best) correct++;

      const bestC = ex.candidates[ex.best]!;
      const bestPref = prefs[ex.best]!;
      for (let j = 0; j < ex.candidates.length; j++) {
        if (j === ex.best) continue;
        const c = ex.candidates[j]!;
        const margin = marginScale * c.cpLoss;
        if (margin <= 0) continue; // same-quality sibling: no ordering constraint
        pairs++;
        const slack = margin - (bestPref - prefs[j]!);
        if (slack > 0) {
          violations++;
          lossSum += slack;
          // dLoss/dw = −(coef_best − coef_j); GD step increases the gap.
          for (let k = 0; k < flat.length; k++) {
            const cb = bestC.terminal ? 0 : bestC.coef[k] ?? 0;
            const cj = c.terminal ? 0 : c.coef[k] ?? 0;
            grad[k] = (grad[k] ?? 0) + (cj - cb);
          }
        }
      }
    }
    const n = Math.max(pairs, 1);
    for (let k = 0; k < flat.length; k++) {
      const g = (grad[k] ?? 0) / n + l2 * ((flat[k] ?? 0) - (def[k] ?? 0));
      flat[k] = (flat[k] ?? 0) - lr * g;
    }
    history.push({
      epoch,
      loss: lossSum / n / 100, // pawns
      violationRate: violations / n,
      rankAccuracy: examples.length ? correct / examples.length : 0,
    });
  }

  return { weights: unflattenValueWeights(flat), history, examples: examples.length, pairs: totalPairs };
}
