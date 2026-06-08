import { Chess } from "chess.js";
import type { Move, Square } from "chess.js";
import { EXTENDED_CENTER, PIECE_VALUE } from "../constants.js";
import { kingSquare, kingZone, opposite } from "../board.js";
import { pstValueMg } from "../value/pst.js";
import type { MoveFeatures } from "../types.js";
import { see } from "./see.js";

const EXTENDED_CENTER_SET = new Set<string>(EXTENDED_CENTER);

/**
 * Compute the {@link MoveFeatures} for a single legal move. `chess` must be the
 * position the move is legal in; `move` is a verbose move object from
 * `chess.moves({ verbose: true })`.
 */
export function computeMoveFeatures(chess: Chess, move: Move): MoveFeatures {
  const fen = chess.fen();
  const us = move.color;
  const them = opposite(us);

  const isCapture = move.flags.includes("c") || move.flags.includes("e") ? 1 : 0;
  const isEnPassant = move.flags.includes("e") ? 1 : 0;
  const isPromotion = move.flags.includes("p") ? 1 : 0;
  const isCastle = move.flags.includes("k") || move.flags.includes("q") ? 1 : 0;
  const isCheck = move.san.includes("+") || move.san.includes("#") ? 1 : 0;

  const captureValue = move.captured ? PIECE_VALUE[move.captured] : isEnPassant ? PIECE_VALUE.p : 0;
  const seeScore = see(fen, move.from, move.to);

  const wasAttacked = chess.attackers(move.from, them).length > 0;
  const escapesAttack = wasAttacked ? 1 : 0;

  const destAttacked = chess.attackers(move.to, them).length > 0;
  const movesIntoDanger = destAttacked && seeScore < 0 ? 1 : 0;

  const pstDelta =
    pstValueMg(move.piece, us, move.to) - pstValueMg(move.piece, us, move.from);

  const fromRank = Number.parseInt(move.from[1]!, 10);
  const backRank = us === "w" ? 2 : 7;
  const develops =
    (move.piece === "n" || move.piece === "b") && fromRank === backRank ? 1 : 0;

  const movesToCenter = EXTENDED_CENTER_SET.has(move.to) ? 1 : 0;

  // Post-move attack picture from the moved piece's destination square.
  const after = new Chess(move.after);
  const enemyKing = kingSquare(after, them);
  let attacksKingZone = 0;
  if (enemyKing) {
    for (const zoneSq of kingZone(enemyKing)) {
      if (after.attackers(zoneSq, us).includes(move.to)) {
        attacksKingZone = 1;
        break;
      }
    }
  }

  let createsThreat = 0;
  for (const row of after.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== them || piece.type === "k") continue;
      if (after.attackers(piece.square as Square, us).includes(move.to)) {
        createsThreat++;
      }
    }
  }

  return {
    isCapture,
    isCheck,
    isPromotion,
    isCastle,
    isEnPassant,
    see: seeScore,
    captureValue,
    escapesAttack,
    movesIntoDanger,
    pstDelta,
    develops,
    attacksKingZone,
    movesToCenter,
    createsThreat,
  };
}

/** Feature rows for every legal move in `fen`. */
export function featuresForAllMoves(fen: string): { move: Move; features: MoveFeatures }[] {
  const chess = new Chess(fen);
  return chess.moves({ verbose: true }).map((move) => ({
    move,
    features: computeMoveFeatures(chess, move),
  }));
}
