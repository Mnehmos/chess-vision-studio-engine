import type { Color, PieceSymbol } from "../chess.js";
import { Chess } from "../chess.js";

const PIECES: PieceSymbol[] = ["p", "n", "b", "r", "q", "k"];
const COLORS: Color[] = ["w", "b"];
const MASK = (1n << 64n) - 1n;
const PIECE_KEYS = Array.from({ length: 12 * 64 }, (_, index) => random64(BigInt(index + 1)));
const SIDE_KEY = random64(10_000n);
const CASTLING_KEYS = Array.from({ length: 4 }, (_, index) => random64(20_000n + BigInt(index)));
const EP_FILE_KEYS = Array.from({ length: 8 }, (_, index) => random64(30_000n + BigInt(index)));

export function zobristKey(chess: Chess): string {
  let key = 0n;
  const state = chess.engineState();

  for (let squareIndex = 0; squareIndex < 64; squareIndex++) {
    const piece = state.pieces[squareIndex];
    if (!piece) continue;
    key ^= PIECE_KEYS[pieceIndex(piece.color, piece.type) * 64 + squareIndex]!;
  }

  if (state.sideToMove === "b") key ^= SIDE_KEY;

  if (state.castling.K) key ^= CASTLING_KEYS[0]!;
  if (state.castling.Q) key ^= CASTLING_KEYS[1]!;
  if (state.castling.k) key ^= CASTLING_KEYS[2]!;
  if (state.castling.q) key ^= CASTLING_KEYS[3]!;

  const ep = state.epSquare;
  if (ep) key ^= EP_FILE_KEYS[ep.charCodeAt(0) - 97]!;

  return key.toString(16).padStart(16, "0");
}

function pieceIndex(color: Color, piece: PieceSymbol): number {
  return COLORS.indexOf(color) * PIECES.length + PIECES.indexOf(piece);
}

function random64(seed: bigint): bigint {
  let z = (seed + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}
