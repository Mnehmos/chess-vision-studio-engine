import { Chess } from "../chess.js";
import type { PieceSymbol, Square } from "../chess.js";
import { PIECE_VALUE } from "../constants.js";
import { opposite } from "../board.js";

/**
 * Static Exchange Evaluation for the move `from -> to`, in centipawns, from the
 * moving side's perspective. Positive means the side to move comes out ahead in
 * the capture sequence on `to`; negative means the piece is likely to be lost.
 *
 * The exchange is simulated on a mutable clone of the board, recomputing
 * attackers after each capture so that x-ray attackers (a rook behind a rook,
 * a queen behind a bishop) are revealed naturally. Kings are only allowed to
 * participate as the final capturer when no enemy attacker remains, matching
 * the legality constraint that a king may not capture into defence.
 */
export function see(fen: string, from: Square, to: Square): number {
  const c = new Chess(fen);
  const attacker = c.get(from);
  if (!attacker) return 0;

  const occupant = c.get(to);
  const gain: number[] = [];
  gain[0] = occupant ? PIECE_VALUE[occupant.type] : 0;

  // Play the initial capture/move on the clone.
  let movingType: PieceSymbol = attacker.type;
  let movingColor = attacker.color;
  let standingValue = PIECE_VALUE[movingType];
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
}
