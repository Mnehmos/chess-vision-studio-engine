import type { Color, PieceSymbol, Square } from "chess.js";
import { fileOf, rankOf } from "../board.js";

/**
 * Piece-square tables, classical "simplified evaluation" values
 * (Tomasz Michniewski). Each table is 64 entries in *visual* order:
 * index 0 = a8, index 7 = h8, index 56 = a1, index 63 = h1 — i.e. the way a
 * board prints with rank 8 on top. {@link pstValue} maps a square + colour to
 * the right entry and mirrors vertically for Black.
 */

// prettier-ignore
const PAWN_MG = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];

// prettier-ignore
const KNIGHT_MG = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];

// prettier-ignore
const BISHOP_MG = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];

// prettier-ignore
const ROOK_MG = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];

// prettier-ignore
const QUEEN_MG = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];

// prettier-ignore
const KING_MG = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];

// prettier-ignore
const KING_EG = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

const TABLES_MG: Record<PieceSymbol, number[]> = {
  p: PAWN_MG,
  n: KNIGHT_MG,
  b: BISHOP_MG,
  r: ROOK_MG,
  q: QUEEN_MG,
  k: KING_MG,
};

const TABLES_EG: Record<PieceSymbol, number[]> = {
  p: PAWN_MG,
  n: KNIGHT_MG,
  b: BISHOP_MG,
  r: ROOK_MG,
  q: QUEEN_MG,
  k: KING_EG,
};

/** Visual-order index (a8=0 .. h1=63) for a square, mirrored for Black. */
function tableIndex(color: Color, sq: Square): number {
  const f = fileOf(sq);
  const r = rankOf(sq); // 0 = rank 1
  // White: rank 8 is visual row 0 -> row = 7 - r. Black mirrors vertically.
  const row = color === "w" ? 7 - r : r;
  return row * 8 + f;
}

/** Middlegame piece-square bonus for a piece of `color` on `sq` (own perspective). */
export function pstValueMg(type: PieceSymbol, color: Color, sq: Square): number {
  return TABLES_MG[type][tableIndex(color, sq)]!;
}

/** Endgame piece-square bonus for a piece of `color` on `sq` (own perspective). */
export function pstValueEg(type: PieceSymbol, color: Color, sq: Square): number {
  return TABLES_EG[type][tableIndex(color, sq)]!;
}
