import { Chess } from "./chess.js";
import type { Color, Square } from "./chess.js";

/** File index 0..7 (a=0). */
export function fileOf(sq: Square): number {
  return sq.charCodeAt(0) - 97;
}

/** Rank index 0..7 where rank 1 = 0 (White's back rank). */
export function rankOf(sq: Square): number {
  return Number.parseInt(sq[1]!, 10) - 1;
}

export function squareFrom(file: number, rank: number): Square {
  return (String.fromCharCode(97 + file) + String(rank + 1)) as Square;
}

/** All squares reachable as the 8 surrounding squares of `sq` (the "king zone"). */
export function kingZone(sq: Square): Square[] {
  const f = fileOf(sq);
  const r = rankOf(sq);
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      out.push(squareFrom(nf, nr));
    }
  }
  return out;
}

export function kingSquare(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) {
        return piece.square;
      }
    }
  }
  return null;
}

export function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

/**
 * Build a FEN identical to `fen` but with the side-to-move flipped and en
 * passant cleared. Returns null when the resulting position is illegal (e.g.
 * the side that "just moved" would be in check). Used to measure the opponent's
 * mobility without an actual null move.
 */
export function nullMoveFen(fen: string): string | null {
  const parts = fen.split(" ");
  if (parts.length < 4) return null;
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const candidate = parts.join(" ");
  try {
    // eslint-disable-next-line no-new
    new Chess(candidate);
    return candidate;
  } catch {
    return null;
  }
}
