// Per-position linear partials of evaluateWhiteFloat w.r.t. the flat value
// weights. Because evaluateWhiteFloat is LINEAR in the weights with zero
// intercept, evaluateWhiteFloat(chess, w) === flatten(w) · flatPartials(chess)
// exactly. Both the regression trainer (train.ts) and the sibling-ranking
// trainer (trainRanking.ts) build on these closed-form coefficients.
import { Chess } from "chess.js";
import { MAX_PHASE, PIECE_VALUE } from "../constants.js";
import { pstValueEg, pstValueMg } from "./pst.js";
import { phaseUnits } from "./valueEngine.js";

export const PIECE_TYPES = ["p", "n", "b", "r", "q"] as const;

export interface PositionPartials {
  /** cp coefficient per material weight: PIECE_VALUE[t] * (whiteCount - blackCount). */
  matCoef: number[];
  /** cp: sum over pieces of sign * (mg*mgWeight + eg*egWeight). */
  posSum: number;
  /** (+1 if white has the bishop pair) + (-1 if black does). */
  pairInd: number;
  /** +1 white to move, -1 black to move. */
  tempoSign: number;
}

/** Walk the board once and accumulate the closed-form partials. */
export function positionPartials(chess: Chess): PositionPartials {
  const units = phaseUnits(chess);
  const mgWeight = units / MAX_PHASE;
  const egWeight = 1 - mgWeight;

  const count: Record<string, number> = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  let posSum = 0;
  let whiteBishops = 0;
  let blackBishops = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const sign = piece.color === "w" ? 1 : -1;
      if (piece.type !== "k") count[piece.type] = (count[piece.type] ?? 0) + sign;
      const mg = pstValueMg(piece.type, piece.color, piece.square);
      const eg = pstValueEg(piece.type, piece.color, piece.square);
      posSum += sign * (mg * mgWeight + eg * egWeight);
      if (piece.type === "b") {
        if (piece.color === "w") whiteBishops++;
        else blackBishops++;
      }
    }
  }
  const matCoef = PIECE_TYPES.map((t) => PIECE_VALUE[t] * (count[t] ?? 0));
  const pairInd = (whiteBishops >= 2 ? 1 : 0) - (blackBishops >= 2 ? 1 : 0);
  const tempoSign = chess.turn() === "w" ? 1 : -1;
  return { matCoef, posSum, pairInd, tempoSign };
}

/** Flatten to the canonical 8-vector order [p,n,b,r,q,pstScale,bishopPair,tempo]. */
export function flatPartials(p: PositionPartials): number[] {
  return [p.matCoef[0]!, p.matCoef[1]!, p.matCoef[2]!, p.matCoef[3]!, p.matCoef[4]!, p.posSum, p.pairInd, p.tempoSign];
}

/** Dot product of a flat weight vector and a flat partial vector. */
export function dot(flat: number[], coef: number[]): number {
  let s = 0;
  for (let k = 0; k < flat.length; k++) s += (flat[k] ?? 0) * (coef[k] ?? 0);
  return s;
}
