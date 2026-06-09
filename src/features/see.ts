import { Chess } from "chess.js";
import type { Color, PieceSymbol, Square } from "chess.js";
import { PIECE_VALUE } from "../constants.js";
import { opposite } from "../board.js";

type BoardPiece = { type: PieceSymbol; color: Color } | null;

/**
 * Static Exchange Evaluation for the move `from -> to`, in centipawns, from the
 * moving side's perspective. Positive means the side to move comes out ahead in
 * the capture sequence on `to`; negative means the piece is likely to be lost.
 *
 * {@link seeOnBoard} runs the swap simulation IN PLACE on an already-parsed board
 * and restores every square it touched before returning, so the caller's board is
 * byte-identical afterwards. This avoids re-parsing a FEN on every capture / quiet
 * candidate in the search hot path (the dominant quiescence cost). {@link see} is
 * the FEN-string entry point for callers that don't already hold a parsed board.
 *
 * The exchange recomputes attackers after each capture so x-ray attackers (a rook
 * behind a rook, a queen behind a bishop) are revealed naturally. Kings only
 * participate as the final capturer when no enemy attacker remains.
 */
export function seeOnBoard(c: Chess, from: Square, to: Square): number {
  // Record the original occupant of every square we mutate, then restore them all
  // in `finally` so `c` is left exactly as we found it (placement-identical).
  const orig = new Map<Square, BoardPiece>();
  const touch = (sq: Square) => {
    if (!orig.has(sq)) orig.set(sq, c.get(sq) ?? null);
  };
  try {
    const attacker = c.get(from);
    if (!attacker) return 0;

    const occupant = c.get(to);
    const gain: number[] = [];
    gain[0] = occupant ? PIECE_VALUE[occupant.type] : 0;

    let movingType: PieceSymbol = attacker.type;
    let movingColor: Color = attacker.color;
    let standingValue = PIECE_VALUE[movingType];
    touch(from);
    touch(to);
    c.remove(from);
    c.remove(to);
    c.put({ type: movingType, color: movingColor }, to);

    let side = opposite(movingColor);
    let depth = 0;

    // Safety bound: at most 32 captures can ever occur on one square.
    for (let iter = 0; iter < 32; iter++) {
      const attackerSquares = c.attackers(to, side);
      if (attackerSquares.length === 0) break;

      // Least valuable attacker.
      let lvaSquare: Square | null = null;
      let lvaType: PieceSymbol = "k";
      let lvaValue = Number.POSITIVE_INFINITY;
      for (const sq of attackerSquares) {
        const p = c.get(sq);
        if (!p) continue;
        const v = PIECE_VALUE[p.type];
        if (v < lvaValue) {
          lvaValue = v;
          lvaSquare = sq;
          lvaType = p.type;
        }
      }
      if (lvaSquare === null) break;

      // A king may not recapture if the opponent still defends the square.
      if (lvaType === "k" && c.attackers(to, opposite(side)).length > 0) break;

      depth++;
      gain[depth] = standingValue - gain[depth - 1]!;

      // Recapture: the LVA takes the piece currently standing on `to`.
      standingValue = lvaValue;
      movingType = lvaType;
      movingColor = side;
      touch(lvaSquare);
      c.remove(lvaSquare);
      c.remove(to);
      c.put({ type: movingType, color: movingColor }, to);

      side = opposite(side);
    }

    // Minimax the swap list: each side stops capturing once it stops gaining.
    for (let i = depth; i > 0; i--) {
      gain[i - 1] = -Math.max(-gain[i - 1]!, gain[i]!);
    }
    // `+ 0` normalises a possible IEEE -0 (from negating Math.max) to +0.
    return gain[0]! + 0;
  } finally {
    for (const [sq, piece] of orig) {
      c.remove(sq);
      if (piece) c.put(piece, sq);
    }
  }
}

/** SEE entry point from a FEN string (parses once, then delegates). */
export function see(fen: string, from: Square, to: Square): number {
  return seeOnBoard(new Chess(fen), from, to);
}
