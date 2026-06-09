// Mixed value trainer over the COMBINED weight vector: the 8 base scalars
// (material×5, pstScale, bishopPair, tempo) + the 18 Rung-2 feature weights = 26
// dims. Trains with BOTH objectives at once:
//   - regression (α): predicted White-POV eval → Stockfish evalBefore (Huber).
//     A well-posed signal that anchors material and lets the Rung-2 features learn
//     the variance material/PST cannot explain.
//   - sibling-ranking (β): the best child outranks worse children by a margin ∝
//     cpLoss (negamax sign: preference = parentStmSign·evaluateWhiteFloat(child)).
// evaluateWhiteFloat is LINEAR in all 26 weights, so both gradients are exact.
//
// Feature normalization: base material partials are O(100s) while Rung-2 feature
// partials are O(1-10). Training in RAW space with one lr would move material fast
// and Rung-2 never. We auto-scale each dim by its dataset RMS (floored at 1) and
// train the normalized weights w' = flat·scale, so a single lr moves every dim
// comparably; flat = w'/scale on the way out. Predictions/preferences are computed
// in raw cp throughout (normalization only reparameterizes the gradient).
import { Chess } from "chess.js";
import type { TrainingPosition } from "../types.js";
import { evaluateWhiteFloat } from "./valueEngine.js";
import { positionPartials, flatPartials } from "./partials.js";
import {
  extractRung2Features,
  flattenRung2Features,
  RUNG2_KEYS,
  unflattenRung2Weights,
  type Rung2Weights,
} from "./rung2.js";
import {
  DEFAULT_VALUE_WEIGHTS,
  flattenValueWeights,
  unflattenValueWeights,
  type ValueWeights,
} from "./weights.js";

const BASE_DIM = 8;
const RUNG2_DIM = RUNG2_KEYS.length;
const DIM = BASE_DIM + RUNG2_DIM;
const MATE_SAT_CP = 3000;

export interface MixedTrainOptions {
  epochs?: number; // default 400
  learningRate?: number; // default 0.1 (normalized space)
  l2?: number; // default 1e-3, toward defaults
  regressionWeight?: number; // α, default 1
  rankingWeight?: number; // β, default 1
  huberDelta?: number; // pawns, default 1
  marginScale?: number; // cp gap per cp cpLoss, default 1
  marginCapCp?: number; // margin cap, default 100 (avoid material inflation)
  topK?: number; // default 8
}

export interface MixedHistoryEntry {
  epoch: number;
  regLoss: number; // mean Huber, pawns
  rankLoss: number; // mean hinge slack, pawns
  rankAccuracy: number; // argmax-child == SF best
}

export interface MixedTrainResult {
  base: ValueWeights;
  rung2: Rung2Weights;
  history: MixedHistoryEntry[];
  regExamples: number;
  rankPairs: number;
}

/** Combined 26-dim partials: evaluateWhiteFloat(c, base, rung2) === flat · partials. */
export function combinedPartials(chess: Chess): number[] {
  return [...flatPartials(positionPartials(chess)), ...flattenRung2Features(extractRung2Features(chess))];
}

function defaultCombinedFlat(): number[] {
  return [...flattenValueWeights(DEFAULT_VALUE_WEIGHTS), ...new Array(RUNG2_DIM).fill(0)];
}

function effectiveCp(cp: number | undefined, mate: number | undefined): number | null {
  if (typeof mate === "number") return mate > 0 ? MATE_SAT_CP : -MATE_SAT_CP;
  if (typeof cp === "number") return cp;
  return null;
}

interface RegExample {
  partials: number[]; // 26, raw
  targetCp: number; // White-POV cp
}
interface RankCand {
  coef: number[]; // 26, raw = parentSign · combinedPartials(child); empty if terminal
  prefConst: number; // raw cp for terminal child, else 0
  terminal: boolean;
  cpLoss: number;
}
interface RankExample {
  best: number;
  candidates: RankCand[];
}

function buildRegExamples(positions: TrainingPosition[]): RegExample[] {
  const out: RegExample[] = [];
  for (const pos of positions) {
    let target: number | undefined;
    if (typeof pos.evalBefore === "number") target = Math.max(-MATE_SAT_CP, Math.min(MATE_SAT_CP, pos.evalBefore));
    else {
      const mate = pos.topMoves?.[0]?.mate;
      if (typeof mate === "number") target = (pos.sideToMove === "w" ? 1 : -1) * (mate > 0 ? MATE_SAT_CP : -MATE_SAT_CP);
    }
    if (target === undefined) continue;
    let chess: Chess;
    try {
      chess = new Chess(pos.fen);
    } catch {
      continue;
    }
    out.push({ partials: combinedPartials(chess), targetCp: target });
  }
  return out;
}

function buildRankExamples(positions: TrainingPosition[], topK: number): RankExample[] {
  const out: RankExample[] = [];
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
      const terminal = child.isCheckmate() || child.isStalemate() || child.isInsufficientMaterial() || child.isDraw();
      const coef = terminal ? [] : combinedPartials(child).map((x) => parentSign * x);
      const prefConst = terminal ? parentSign * evaluateWhiteFloat(child) : 0;
      raw.push({ coef, prefConst, terminal, eff });
    }
    if (raw.length < 2) continue;
    let bestEff = -Infinity;
    for (const r of raw) bestEff = Math.max(bestEff, r.eff);
    let best = 0;
    let bestLoss = Infinity;
    const candidates: RankCand[] = raw.map((r, i) => {
      const cpLoss = bestEff - r.eff;
      if (cpLoss < bestLoss) {
        bestLoss = cpLoss;
        best = i;
      }
      return { coef: r.coef, prefConst: r.prefConst, terminal: r.terminal, cpLoss };
    });
    out.push({ best, candidates });
  }
  return out;
}

export function trainValueMixed(positions: TrainingPosition[], options: MixedTrainOptions = {}): MixedTrainResult {
  const epochs = options.epochs ?? 400;
  const lr = options.learningRate ?? 0.1;
  const l2 = options.l2 ?? 1e-3;
  const alpha = options.regressionWeight ?? 1;
  const beta = options.rankingWeight ?? 1;
  const delta = options.huberDelta ?? 1;
  const marginScale = options.marginScale ?? 1;
  const marginCap = options.marginCapCp ?? 100;
  const topK = options.topK ?? 8;

  const reg = buildRegExamples(positions);
  const rank = buildRankExamples(positions, topK);

  // Per-dimension scale = RMS of the regression partials, floored at 1 so small/
  // rare features are never amplified. Normalized weight w'[k] = flat[k]·scale[k].
  const scale = new Array<number>(DIM).fill(0);
  for (const ex of reg) for (let k = 0; k < DIM; k++) scale[k]! += (ex.partials[k] ?? 0) ** 2;
  const nReg = Math.max(reg.length, 1);
  for (let k = 0; k < DIM; k++) scale[k] = Math.max(Math.sqrt(scale[k]! / nReg), 1);

  const defFlat = defaultCombinedFlat();
  const wPrime = defFlat.map((v, k) => v * scale[k]!); // start at defaults
  const defPrime = defFlat.map((v, k) => v * scale[k]!);

  const norm = (raw: number[]): number[] => raw.map((v, k) => v / scale[k]!);
  const predRaw = (wp: number[], partials: number[]): number => {
    // pred = Σ flat·partial = Σ (wp/scale)·partial = Σ wp·(partial/scale)
    let s = 0;
    for (let k = 0; k < DIM; k++) s += wp[k]! * (partials[k] ?? 0) / scale[k]!;
    return s;
  };

  const history: MixedHistoryEntry[] = [];
  let totalPairs = 0;
  for (const ex of rank) for (let j = 0; j < ex.candidates.length; j++) if (j !== ex.best && ex.candidates[j]!.cpLoss > 0) totalPairs++;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array<number>(DIM).fill(0);

    // Regression term (α).
    let regLossSum = 0;
    for (const ex of reg) {
      const e = (predRaw(wPrime, ex.partials) - ex.targetCp) / 100; // pawns
      const ae = Math.abs(e);
      const hPrime = ae <= delta ? e : delta * Math.sign(e);
      regLossSum += ae <= delta ? 0.5 * e * e : delta * (ae - 0.5 * delta);
      const pn = norm(ex.partials);
      for (let k = 0; k < DIM; k++) grad[k]! += (alpha * hPrime * pn[k]!) / 100 / nReg;
    }

    // Ranking term (β).
    let rankLossSum = 0;
    let correct = 0;
    const nPairs = Math.max(totalPairs, 1);
    for (const ex of rank) {
      // coef is already parentSign·partials(child) in RAW space; predRaw divides by scale.
      const prefs = ex.candidates.map((c) => (c.terminal ? c.prefConst : predRaw(wPrime, c.coef)));
      let argmax = 0;
      for (let i = 1; i < prefs.length; i++) if (prefs[i]! > prefs[argmax]!) argmax = i;
      if (argmax === ex.best) correct++;
      const bestC = ex.candidates[ex.best]!;
      const bestPref = prefs[ex.best]!;
      const bestCoefN = bestC.terminal ? null : norm(bestC.coef);
      for (let j = 0; j < ex.candidates.length; j++) {
        if (j === ex.best) continue;
        const c = ex.candidates[j]!;
        const margin = Math.min(marginScale * c.cpLoss, marginCap);
        if (margin <= 0) continue;
        const slack = margin - (bestPref - prefs[j]!);
        if (slack > 0) {
          rankLossSum += slack;
          const cjN = c.terminal ? null : norm(c.coef);
          for (let k = 0; k < DIM; k++) {
            const cb = bestCoefN ? bestCoefN[k]! : 0;
            const cj = cjN ? cjN[k]! : 0;
            grad[k]! += (beta * (cj - cb)) / nPairs;
          }
        }
      }
    }

    // L2 toward defaults + step.
    for (let k = 0; k < DIM; k++) {
      grad[k]! += l2 * (wPrime[k]! - defPrime[k]!);
      wPrime[k] = wPrime[k]! - lr * grad[k]!;
    }

    history.push({
      epoch,
      regLoss: regLossSum / nReg,
      rankLoss: rankLossSum / nPairs / 100,
      rankAccuracy: rank.length ? correct / rank.length : 0,
    });
  }

  const flat = wPrime.map((v, k) => v / scale[k]!);
  return {
    base: unflattenValueWeights(flat.slice(0, BASE_DIM)),
    rung2: unflattenRung2Weights(flat.slice(BASE_DIM)),
    history,
    regExamples: reg.length,
    rankPairs: totalPairs,
  };
}
