import { Chess } from "../chess.js";
import type { Color, Square } from "../chess.js";
import { CENTER_SQUARES, PIECE_VALUE } from "../constants.js";
import { kingSquare, kingZone, nullMoveFen, opposite } from "../board.js";
import { phaseLabel } from "../value/valueEngine.js";
import type { PositionFeatures } from "../types.js";
import { see } from "./see.js";
import { detectMotifs } from "./motifs.js";

interface SideMobility {
  mobility: number;
  safeMoves: number;
}

/** Mobility + count of non-losing moves for whichever side is to move in `chess`. */
function sideToMoveMobility(chess: Chess): SideMobility {
  const fen = chess.fen();
  const moves = chess.moves({ verbose: true });
  let safe = 0;
  for (const m of moves) {
    if (see(fen, m.from, m.to) >= 0) safe++;
  }
  return { mobility: moves.length, safeMoves: safe };
}

/** Mobility for a specific colour, using a null move when it is not their turn. */
function mobilityFor(chess: Chess, color: Color): SideMobility {
  if (chess.turn() === color) return sideToMoveMobility(chess);
  const flipped = nullMoveFen(chess.fen());
  if (!flipped) return { mobility: 0, safeMoves: 0 };
  try {
    return sideToMoveMobility(new Chess(flipped));
  } catch {
    return { mobility: 0, safeMoves: 0 };
  }
}

/** Number of `color` pieces attacked by the enemy and not defended by a friend. */
function loosePieces(chess: Chess, color: Color): number {
  const enemy = opposite(color);
  let count = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== color || piece.type === "k") continue;
      const attacked = chess.attackers(piece.square, enemy).length > 0;
      const defended = chess.attackers(piece.square, color).length > 0;
      if (attacked && !defended) count++;
    }
  }
  return count;
}

/** Total centipawns the enemy can win by best capture across all `color` pieces. */
function hangingValue(chess: Chess, color: Color): number {
  const enemy = opposite(color);
  const fen = chess.fen();
  let total = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== color || piece.type === "k") continue;
      const attackerSquares = chess.attackers(piece.square, enemy);
      if (attackerSquares.length === 0) continue;
      let best = 0;
      for (const from of attackerSquares) {
        best = Math.max(best, see(fen, from, piece.square));
      }
      if (best > 0) total += best;
    }
  }
  return total;
}

/** Count of center squares (d4/e4/d5/e5) attacked by `color`. */
function centerControl(chess: Chess, color: Color): number {
  let count = 0;
  for (const sq of CENTER_SQUARES) {
    if (chess.attackers(sq as Square, color).length > 0) count++;
  }
  return count;
}

/** Number of enemy attacks landing on squares around `color`'s king. */
function kingPressure(chess: Chess, color: Color): number {
  const ksq = kingSquare(chess, color);
  if (!ksq) return 0;
  const enemy = opposite(color);
  let pressure = 0;
  for (const sq of kingZone(ksq)) {
    pressure += chess.attackers(sq, enemy).length;
  }
  return pressure;
}

/**
 * Compute the full {@link PositionFeatures} block for a FEN. The shape matches
 * the Chess Vision Studio analysis export so a CVS ply can be folded straight
 * into a {@link import("../types.js").TrainingPosition}.
 */
export function extractPositionFeatures(fen: string): PositionFeatures {
  const chess = new Chess(fen);

  let materialBalance = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.type === "k") continue;
      materialBalance += (piece.color === "w" ? 1 : -1) * PIECE_VALUE[piece.type];
    }
  }

  const whiteMobility = mobilityFor(chess, "w");
  const blackMobility = mobilityFor(chess, "b");

  const hangingWhite = hangingValue(chess, "w");
  const hangingBlack = hangingValue(chess, "b");
  const motifs = detectMotifs(fen);
  if (hangingWhite > 0 || hangingBlack > 0) motifs.push("hanging-material");

  return {
    phase: phaseLabel(chess),
    materialBalance,
    kingPressureWhite: kingPressure(chess, "w"),
    kingPressureBlack: kingPressure(chess, "b"),
    loosePiecesWhite: loosePieces(chess, "w"),
    loosePiecesBlack: loosePieces(chess, "b"),
    hangingValueWhite: hangingWhite,
    hangingValueBlack: hangingBlack,
    centerControlWhite: centerControl(chess, "w"),
    centerControlBlack: centerControl(chess, "b"),
    mobilityWhite: whiteMobility.mobility,
    mobilityBlack: blackMobility.mobility,
    safeMovesWhite: whiteMobility.safeMoves,
    safeMovesBlack: blackMobility.safeMoves,
    motifs: [...new Set(motifs)].sort(),
  };
}
