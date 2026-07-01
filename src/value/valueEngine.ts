import { Chess } from "../chess.js";
import type { Color } from "../chess.js";
import { MATE_SCORE, MAX_PHASE, PHASE_VALUE, PIECE_VALUE } from "../constants.js";
import type { GamePhase } from "../types.js";
import { pstValueEg, pstValueMg } from "./pst.js";
import { classicalTermTotal, scaleEndgameScore } from "./classicalTerms.js";

/** Non-pawn material on the board (0..24), used to taper mg/eg and label phase. */
export function phaseUnits(chess: Chess): number {
  let units = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece) units += PHASE_VALUE[piece.type];
    }
  }
  return Math.min(units, MAX_PHASE);
}

export function phaseLabel(chess: Chess): GamePhase {
  const units = phaseUnits(chess);
  if (units >= 20) return "opening";
  if (units <= 8) return "endgame";
  return "middlegame";
}

/**
 * Static evaluation in centipawns from **White's** perspective.
 *
 * Terms: tapered material + piece-square tables, a bishop-pair bonus, and a
 * small tempo bonus for the side to move. Terminal positions short-circuit to a
 * mate/stalemate score. This is intentionally a transparent handcrafted value
 * function for the classical engine.
 */
export function evaluateWhite(chess: Chess): number {
  return evaluateWhiteInternal(chess, { terminal: true, classicalTerms: true });
}

/**
 * Fast static evaluation for alpha-beta leaves.
 *
 * The public evaluator intentionally includes richer classical terms that are
 * useful for analysis, tuning, and reporting. Search needs a much cheaper leaf
 * function because it calls evaluation thousands of times per move.
 */
export function evaluateWhiteSearch(chess: Chess): number {
  return evaluateWhiteInternal(chess, { terminal: false, classicalTerms: false });
}

function evaluateWhiteInternal(
  chess: Chess,
  options: { terminal: boolean; classicalTerms: boolean },
): number {
  if (options.terminal) {
    if (chess.isCheckmate()) {
      // Side to move is mated => bad for them.
      return chess.turn() === "w" ? -MATE_SCORE : MATE_SCORE;
    }
    if (chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial()) {
      return 0;
    }
  }

  const units = phaseUnits(chess);
  const mgWeight = units / MAX_PHASE; // 1 = full opening, 0 = bare endgame
  const egWeight = 1 - mgWeight;

  let score = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const sign = piece.color === "w" ? 1 : -1;
      const material = PIECE_VALUE[piece.type];
      const mg = pstValueMg(piece.type, piece.color, piece.square);
      const eg = pstValueEg(piece.type, piece.color, piece.square);
      const positional = mg * mgWeight + eg * egWeight;
      score += sign * (material + positional);
      if (piece.type === "b") {
        if (piece.color === "w") whiteBishops++;
        else blackBishops++;
      }
    }
  }

  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  if (options.classicalTerms) score += classicalTermTotal(chess);

  // Tempo: a small bonus for having the move.
  score += chess.turn() === "w" ? 10 : -10;

  return Math.round(scaleEndgameScore(chess, score));
}

/** Static evaluation from the **side-to-move's** perspective (negamax convention). */
export function evaluate(chess: Chess): number {
  const white = evaluateWhite(chess);
  return chess.turn() === "w" ? white : -white;
}

/** Fast static evaluation from the side-to-move's perspective for search. */
export function evaluateSearch(chess: Chess): number {
  const white = evaluateWhiteSearch(chess);
  return chess.turn() === "w" ? white : -white;
}

export function sideSign(color: Color): number {
  return color === "w" ? 1 : -1;
}
