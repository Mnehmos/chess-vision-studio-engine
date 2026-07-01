import { Chess, type Color, type Piece, type Square } from "../chess.js";
import { CENTER_SQUARES, EXTENDED_CENTER, PIECE_VALUE } from "../constants.js";
import { kingSquare, kingZone, nullMoveFen, opposite } from "../board.js";
import { see } from "../features/see.js";

type FilePawns = Record<Color, number[][]>;

const MOBILITY_WEIGHT = { n: 3, b: 3, r: 2, q: 1, p: 0, k: 0 } as const;

export interface ClassicalTermBreakdown {
  pawnStructure: number;
  kingSafety: number;
  mobility: number;
  filesAndRanks: number;
  minorPieces: number;
  space: number;
  center: number;
}

export function evaluateClassicalTerms(chess: Chess): ClassicalTermBreakdown {
  return {
    pawnStructure: pawnStructureScore(chess),
    kingSafety: kingSafetyScore(chess),
    mobility: mobilityScore(chess),
    filesAndRanks: filesAndRanksScore(chess),
    minorPieces: minorPieceScore(chess),
    space: spaceScore(chess),
    center: centerScore(chess),
  };
}

export function classicalTermTotal(chess: Chess): number {
  const terms = evaluateClassicalTerms(chess);
  return Object.values(terms).reduce((sum, value) => sum + value, 0);
}

export function scaleEndgameScore(chess: Chess, score: number): number {
  const pieces = allPieces(chess).filter((piece) => piece.type !== "k");
  const nonPawns = pieces.filter((piece) => piece.type !== "p");
  const heavy = pieces.filter((piece) => piece.type === "r" || piece.type === "q");
  const bishops = pieces.filter((piece) => piece.type === "b");
  const pawns = pieces.filter((piece) => piece.type === "p");

  if (pieces.length === 0) return 0;
  if (nonPawns.length === 1 && pawns.length === 0 && (nonPawns[0]?.type === "b" || nonPawns[0]?.type === "n")) return 0;
  if (heavy.length === 0 && bishops.length === 2 && bishops[0]?.color !== bishops[1]?.color) {
    return Math.round(score * 0.65);
  }
  if (heavy.length === 0 && nonPawns.length <= 2 && pawns.length <= 2) {
    return Math.round(score * 0.75);
  }
  return score;
}

function pawnStructureScore(chess: Chess): number {
  const pawns = pawnFiles(chess);
  let score = 0;
  for (const color of ["w", "b"] as const) {
    const sign = color === "w" ? 1 : -1;
    for (let file = 0; file < 8; file++) {
      const ranks = pawns[color][file]!;
      if (ranks.length > 1) score -= sign * 12 * (ranks.length - 1);
      for (const rank of ranks) {
        if (isIsolatedPawn(pawns, color, file)) score -= sign * 10;
        if (isBackwardPawn(chess, pawns, color, file, rank)) score -= sign * 8;
        if (isPassedPawn(pawns, color, file, rank)) {
          const advancement = color === "w" ? rank : 7 - rank;
          score += sign * (18 + advancement * 7);
          if (isProtectedByPawn(pawns, color, file, rank)) score += sign * 12;
          if (hasConnectedPawn(pawns, color, file, rank)) score += sign * 8;
        }
      }
    }
  }
  return score;
}

function kingSafetyScore(chess: Chess): number {
  let score = 0;
  for (const color of ["w", "b"] as const) {
    const sign = color === "w" ? 1 : -1;
    const king = kingSquare(chess, color);
    if (!king) continue;
    const [file, rank] = parseSquare(king);
    const enemy = opposite(color);
    let sideScore = 0;

    for (const sq of kingZone(king)) {
      sideScore -= chess.attackers(sq, enemy).length * 7;
    }

    for (const df of [-1, 0, 1]) {
      const shieldFile = file + df;
      if (shieldFile < 0 || shieldFile > 7) continue;
      const nearRank = rank + (color === "w" ? 1 : -1);
      const farRank = rank + (color === "w" ? 2 : -2);
      const nearPawn = onBoard(shieldFile, nearRank) && pieceAt(chess, shieldFile, nearRank)?.type === "p" && pieceAt(chess, shieldFile, nearRank)?.color === color;
      const farPawn = onBoard(shieldFile, farRank) && pieceAt(chess, shieldFile, farRank)?.type === "p" && pieceAt(chess, shieldFile, farRank)?.color === color;
      sideScore += nearPawn ? 8 : farPawn ? 4 : -7;
      if (!hasPawnOnFile(chess, color, shieldFile)) sideScore -= 10;
      if (!hasAnyPawnOnFile(chess, shieldFile)) sideScore -= 8;
    }

    sideScore -= safeChecks(chess, enemy) * 6;
    score += sign * sideScore;
  }
  return score;
}

function mobilityScore(chess: Chess): number {
  return sideMobility(chess, "w") - sideMobility(chess, "b");
}

function filesAndRanksScore(chess: Chess): number {
  let score = 0;
  for (const piece of allPieces(chess)) {
    if (piece.type !== "r" && piece.type !== "q") continue;
    const sign = piece.color === "w" ? 1 : -1;
    const [file, rank] = parseSquare(piece.square);
    const friendlyPawn = hasPawnOnFile(chess, piece.color, file);
    const anyPawn = hasAnyPawnOnFile(chess, file);
    if (!anyPawn) score += sign * (piece.type === "r" ? 22 : 10);
    else if (!friendlyPawn) score += sign * (piece.type === "r" ? 12 : 5);
    if (piece.type === "r" && ((piece.color === "w" && rank === 6) || (piece.color === "b" && rank === 1))) {
      score += sign * 22;
    }
  }
  return score;
}

function minorPieceScore(chess: Chess): number {
  let score = 0;
  for (const piece of allPieces(chess)) {
    const sign = piece.color === "w" ? 1 : -1;
    if (piece.type === "n" && isKnightOutpost(chess, piece)) score += sign * 24;
    if (piece.type === "b") {
      const mobility = pieceMobility(chess, piece);
      score += sign * Math.min(18, mobility * 2);
      if (isBadBishop(chess, piece)) score -= sign * 18;
      if (isTrappedBishop(chess, piece)) score -= sign * 30;
    }
  }
  return score;
}

function spaceScore(chess: Chess): number {
  let score = 0;
  for (const piece of allPieces(chess)) {
    if (piece.type === "k") continue;
    const sign = piece.color === "w" ? 1 : -1;
    const [, rank] = parseSquare(piece.square);
    if (piece.color === "w" && rank >= 3 && rank <= 5) score += sign * 3;
    if (piece.color === "b" && rank >= 2 && rank <= 4) score += sign * 3;
  }
  return score;
}

function centerScore(chess: Chess): number {
  let score = 0;
  for (const sq of CENTER_SQUARES) {
    score += chess.attackers(sq as Square, "w").length * 6;
    score -= chess.attackers(sq as Square, "b").length * 6;
  }
  for (const sq of EXTENDED_CENTER) {
    score += chess.attackers(sq as Square, "w").length * 2;
    score -= chess.attackers(sq as Square, "b").length * 2;
  }
  return score;
}

function safeChecks(chess: Chess, color: Color): number {
  const probe = chess.turn() === color ? new Chess(chess.fen()) : nullMoveChess(chess);
  if (!probe) return 0;
  const fen = probe.fen();
  return probe
    .moves({ verbose: true })
    .filter((move) => move.san.includes("+") || move.san.includes("#"))
    .filter((move) => see(fen, move.from, move.to) >= 0).length;
}

function sideMobility(chess: Chess, color: Color): number {
  const probe = chess.turn() === color ? new Chess(chess.fen()) : nullMoveChess(chess);
  if (!probe) return 0;
  return probe.moves({ verbose: true }).reduce((sum, move) => sum + MOBILITY_WEIGHT[move.piece], 0);
}

function pieceMobility(chess: Chess, piece: Piece): number {
  const probe = chess.turn() === piece.color ? new Chess(chess.fen()) : nullMoveChess(chess);
  if (!probe) return 0;
  return probe.moves({ verbose: true }).filter((move) => move.from === piece.square).length;
}

function nullMoveChess(chess: Chess): Chess | null {
  const fen = nullMoveFen(chess.fen());
  if (!fen) return null;
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function pawnFiles(chess: Chess): FilePawns {
  const files: FilePawns = {
    w: Array.from({ length: 8 }, () => []),
    b: Array.from({ length: 8 }, () => []),
  };
  for (const piece of allPieces(chess)) {
    if (piece.type !== "p") continue;
    const [file, rank] = parseSquare(piece.square);
    files[piece.color][file]!.push(rank);
  }
  return files;
}

function isIsolatedPawn(pawns: FilePawns, color: Color, file: number): boolean {
  return (pawns[color][file - 1]?.length ?? 0) === 0 && (pawns[color][file + 1]?.length ?? 0) === 0;
}

function isBackwardPawn(chess: Chess, pawns: FilePawns, color: Color, file: number, rank: number): boolean {
  const dir = color === "w" ? 1 : -1;
  const frontRank = rank + dir;
  if (!onBoard(file, frontRank)) return false;
  if (isPassedPawn(pawns, color, file, rank)) return false;
  const supportAhead =
    (pawns[color][file - 1]?.some((r) => (color === "w" ? r >= rank : r <= rank)) ?? false) ||
    (pawns[color][file + 1]?.some((r) => (color === "w" ? r >= rank : r <= rank)) ?? false);
  return !supportAhead && chess.attackers(squareOf(file, frontRank), opposite(color)).some((sq) => pieceAtSquare(chess, sq)?.type === "p");
}

function isPassedPawn(pawns: FilePawns, color: Color, file: number, rank: number): boolean {
  const enemy = opposite(color);
  for (let f = file - 1; f <= file + 1; f++) {
    for (const enemyRank of pawns[enemy][f] ?? []) {
      if (color === "w" ? enemyRank > rank : enemyRank < rank) return false;
    }
  }
  return true;
}

function isProtectedByPawn(pawns: FilePawns, color: Color, file: number, rank: number): boolean {
  const supportRank = rank + (color === "w" ? -1 : 1);
  return (pawns[color][file - 1]?.includes(supportRank) ?? false) || (pawns[color][file + 1]?.includes(supportRank) ?? false);
}

function hasConnectedPawn(pawns: FilePawns, color: Color, file: number, rank: number): boolean {
  return (pawns[color][file - 1]?.includes(rank) ?? false) || (pawns[color][file + 1]?.includes(rank) ?? false);
}

function isKnightOutpost(chess: Chess, piece: Piece): boolean {
  const [file, rank] = parseSquare(piece.square);
  const advanced = piece.color === "w" ? rank >= 3 && rank <= 5 : rank >= 2 && rank <= 4;
  if (!advanced) return false;
  const defendedByPawn = chess.attackers(piece.square, piece.color).some((sq) => pieceAtSquare(chess, sq)?.type === "p");
  if (!defendedByPawn) return false;
  const enemy = opposite(piece.color);
  const enemyPawnAttacks = chess.attackers(piece.square, enemy).some((sq) => pieceAtSquare(chess, sq)?.type === "p");
  return !enemyPawnAttacks;
}

function isBadBishop(chess: Chess, bishop: Piece): boolean {
  const bishopColor = squareColor(bishop.square);
  let ownPawnsOnColor = 0;
  for (const piece of allPieces(chess)) {
    if (piece.color === bishop.color && piece.type === "p" && squareColor(piece.square) === bishopColor) ownPawnsOnColor++;
  }
  return ownPawnsOnColor >= 4 && pieceMobility(chess, bishop) <= 4;
}

function isTrappedBishop(chess: Chess, bishop: Piece): boolean {
  return pieceMobility(chess, bishop) <= 1 && chess.attackers(bishop.square, opposite(bishop.color)).length > 0;
}

function hasPawnOnFile(chess: Chess, color: Color, file: number): boolean {
  return allPieces(chess).some((piece) => piece.color === color && piece.type === "p" && parseSquare(piece.square)[0] === file);
}

function hasAnyPawnOnFile(chess: Chess, file: number): boolean {
  return allPieces(chess).some((piece) => piece.type === "p" && parseSquare(piece.square)[0] === file);
}

function allPieces(chess: Chess): Piece[] {
  return chess.board().flat().filter((piece): piece is Piece => Boolean(piece));
}

function pieceAt(chess: Chess, file: number, rank: number): Piece | null {
  return onBoard(file, rank) ? chess.get(squareOf(file, rank)) : null;
}

function pieceAtSquare(chess: Chess, square: Square): Piece | null {
  return chess.get(square);
}

function parseSquare(square: Square): [number, number] {
  return [square.charCodeAt(0) - 97, Number.parseInt(square[1]!, 10) - 1];
}

function squareOf(file: number, rank: number): Square {
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Square;
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function squareColor(square: Square): "light" | "dark" {
  const [file, rank] = parseSquare(square);
  return (file + rank) % 2 === 0 ? "dark" : "light";
}
