import type { PieceSymbol } from "chess.js";

/**
 * Centipawn material values used across the value engine, SEE, and move
 * features. Kept deliberately classical so results are interpretable and
 * comparable against Stockfish-style centipawn output.
 */
export const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

/** Material counted toward the opening->endgame "phase" taper (kings/pawns excluded). */
export const PHASE_VALUE: Record<PieceSymbol, number> = {
  p: 0,
  n: 1,
  b: 1,
  r: 2,
  q: 4,
  k: 0,
};

/** Sum of PHASE_VALUE for a full non-pawn army of both sides (used to normalise phase). */
export const MAX_PHASE = 24;

/** Score returned for a forced mate, scaled by distance so shorter mates win. */
export const MATE_SCORE = 1_000_000;

/** Threshold above which a score is treated as "a mate is involved". */
export const MATE_THRESHOLD = MATE_SCORE - 1000;

export const CENTER_SQUARES = ["d4", "e4", "d5", "e5"] as const;
export const EXTENDED_CENTER = [
  "c3", "d3", "e3", "f3",
  "c4", "d4", "e4", "f4",
  "c5", "d5", "e5", "f5",
  "c6", "d6", "e6", "f6",
] as const;
