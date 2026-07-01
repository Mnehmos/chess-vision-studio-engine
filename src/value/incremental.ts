import { Chess, type Move } from "../chess.js";
import { evaluateWhite, phaseUnits } from "./valueEngine.js";
import { evaluateClassicalTerms, type ClassicalTermBreakdown } from "./classicalTerms.js";

export interface EvaluationState {
  fen: string;
  phaseUnits: number;
  whiteScore: number;
  classicalTerms: ClassicalTermBreakdown;
}

export function createEvaluationState(chess: Chess): EvaluationState {
  return {
    fen: chess.fen(),
    phaseUnits: phaseUnits(chess),
    whiteScore: evaluateWhite(chess),
    classicalTerms: evaluateClassicalTerms(chess),
  };
}

export function updateEvaluationState(state: EvaluationState, move: Move): EvaluationState {
  const chess = new Chess(state.fen);
  const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  if (!applied) throw new Error(`Cannot update evaluation state with illegal move ${move.lan}`);
  return createEvaluationState(chess);
}
