import { Chess, type Color, type Move, type Piece, type PieceSymbol, type Square } from "../chess.js";
import { CENTER_SQUARES, EXTENDED_CENTER, PIECE_VALUE } from "../constants.js";
import { opposite } from "../board.js";
import { see } from "./see.js";

export const MOTIF_TAXONOMY = [
  "avoid trade", "backwards pawn", "bad bishop", "bishop pair", "center control", "centralised king",
  "closed file", "connected pawns", "connected rooks", "defence", "diagonal battery", "diagonal control",
  "domination", "doubled pawns", "doubled rooks", "favourable trade", "file control", "good bishop",
  "improve piece activity", "initiative", "isolated pawn", "king march", "king safety", "knight outpost",
  "limit piece activity", "luft", "minority attack", "open file", "opening centre",
  "opposite colour bishops", "opposite side castling", "outside passed pawn", "overprotection",
  "passed pawn", "pawn blockade", "pawn break", "pawn grab", "pawn majority", "pawn phalanx",
  "pawn storm", "penetration", "piece centralisation", "piece coordination",
  "positional sacrifice - exchange", "positional sacrifice - pawn", "positional sacrifice - piece",
  "positional sacrifice - queen", "positional sacrifice - rook", "prophylaxis", "protected passed pawn",
  "queen+knight coordination", "rank control", "rook lift", "rook on 7th rank", "same colour bishops",
  "semi-open file", "space", "vertical battery", "Alekhine's gun",
  "Anastasia's mate", "Arabian mate", "Balestra mate", "Blackburne's mate", "Damiano's bishop mate",
  "Damiano's mate", "Discovered mate", "Counter Check Checkmate", "Double Checkmate", "Edge Mate",
  "Back Rank Mate", "Edge Pin Mate", "Queen Cutoff Mate", "Side File Mate", "Smothered Mate",
  "Suffocation Mate", "Epaulette Mate", "Escalator Mate", "Greco's Mate", "Hook Mate", "Kill Box Mate",
  "Lawnmower Mate", "Lolli's Mate", "Monorail Mate", "Morphy's Mate", "Opera Mate", "Pawn Checkmates",
  "Pawn Mate", "Promotion Mate", "Pillsbury's Mate", "Queen and Knight Mate", "Railroad Mate",
  "Seizing a Square Mate", "Swallow's Tail Mate", "Threading the Needle Mate", "Boden's Mate",
  "Double Bishop Mate", "Dovetail Mate", "Dovetail Mate - Bishop", "Triangle Mate", "Vukovic Mate",
  "Walking the Plank Mate", "X-Ray Mate",
  "Advanced Pawn", "Non-Promotion Advanced Pawn", "Promotion", "Underpromotion", "Promotion Threat",
  "Underpromotion Threat", "Attraction", "Avoiding Perpetual", "Avoiding Stalemate", "Blocking",
  "Clearance", "Diagonal Clearance", "File Clearance", "Rank Clearance", "Square Clearance",
  "Coercion", "Controlling Escape Square", "Counter Check", "Counting", "Multi-square Counting",
  "Under-protected Piece", "Defensive Move", "Achieving Perpetual", "Avoiding Mate",
  "Defensive Interposition", "Recapture", "Discovery", "Discovered Attack", "Discovered Check",
  "Discoverer Checks", "Double Check", "Discovered Defense", "Exposed King", "Gain of Tempo",
  "Aiming Sequence", "Appended Attack", "Desperado", "Hit and Run", "Hit and Run - Capture Defender",
  "Hit and Run - Discovery", "Jailbreak", "Pendulum", "Reload", "Reprotection", "Rethreaten",
  "Zwischenzug", "Capturing Attacker", "Hanging Piece", "Hook and Ladder", "Mate Threat",
  "Backwards Move", "En Passant", "Long Lateral Move", "Tactical Castling", "Multiple Attack",
  "Double Attack", "Fork", "Family Fork", "Royal Fork", "Tag Team", "Needs Different Opponent Move",
  "Needs More Moves", "Overloading", "Pin", "Absolute Pin", "Cross-pin", "Relative Pin", "Mate Pin",
  "Quiet Move", "Removing the Guard", "Capturing Defender", "Distraction", "Attacking the Defender",
  "Luring the Defender", "Interference", "Sacrifice", "Demolition Sacrifice", "Greek Gift",
  "Exchange Sacrifice", "Passive Sacrifice", "Pawn Sacrifice", "Simplification", "Skewer",
  "Relative Skewer", "Skewer of Queen", "Skewer of Rook", "Skewer of King", "Trapped Piece",
  "Unpinning", "Unsound Sacrifice", "Weak Back Rank", "Win the Exchange", "Windmill",
  "Windmill - Discoveries", "Windmill - Knight Fork", "X-Ray", "X-Ray Attack", "X-Ray Defense",
  "Zugzwang",
] as const;

export const SUPPORTED_MOTIFS = [...new Set(MOTIF_TAXONOMY.map(normalizeMotif))].sort();

export function detectMotifs(fen: string): string[] {
  const chess = new Chess(fen);
  const motifs = new Set<string>();
  addPositionMotifs(chess, motifs);
  addMoveMotifs(chess, motifs);
  addLineMotifs(chess, motifs);
  addMatePatternMotifs(chess, motifs);
  return [...motifs].sort();
}

export function normalizeMotif(value: string): string {
  return value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9+]+/g, "-").replace(/^-+|-+$/g, "");
}

function add(motifs: Set<string>, value: string): void {
  motifs.add(normalizeMotif(value));
}

function addPositionMotifs(chess: Chess, motifs: Set<string>): void {
  if (chess.inCheck()) {
    add(motifs, "check");
    add(motifs, "exposed king");
  }
  if (chess.isStalemate()) add(motifs, "avoiding stalemate");
  if (chess.isCheckmate()) add(motifs, "checkmate");

  for (const color of ["w", "b"] as const) {
    pawnMotifs(chess, color, motifs);
    minorMotifs(chess, color, motifs);
    lineAndCoordinationMotifs(chess, color, motifs);
    kingMotifs(chess, color, motifs);
    activityMotifs(chess, color, motifs);
  }
}

function pawnMotifs(chess: Chess, color: Color, motifs: Set<string>): void {
  const pawns = pieces(chess).filter((piece) => piece.color === color && piece.type === "p");
  const enemyPawns = pieces(chess).filter((piece) => piece.color !== color && piece.type === "p");
  const files = groupByFile(pawns);
  const enemyFiles = groupByFile(enemyPawns);
  const sideFiles = files.map((ranks) => ranks.length);
  const queenSide = sideFiles.slice(0, 4).reduce((a, b) => a + b, 0);
  const kingSide = sideFiles.slice(4).reduce((a, b) => a + b, 0);
  if (Math.abs(queenSide - kingSide) >= 2) add(motifs, "pawn majority");
  if (queenSide < kingSide) add(motifs, "minority attack");

  for (let file = 0; file < 8; file++) {
    if (files[file]!.length > 1) add(motifs, "doubled pawns");
    for (const rank of files[file]!) {
      const isolated = (files[file - 1]?.length ?? 0) === 0 && (files[file + 1]?.length ?? 0) === 0;
      if (isolated) add(motifs, "isolated pawn");
      if (files[file - 1]?.includes(rank) || files[file + 1]?.includes(rank)) {
        add(motifs, "connected pawns");
        add(motifs, "pawn phalanx");
      }
      const passed = isPassed(color, file, rank, enemyFiles);
      if (passed) {
        add(motifs, "passed pawn");
        if (isOutsidePassed(color, file, enemyFiles)) add(motifs, "outside passed pawn");
        const supportRank = rank + (color === "w" ? -1 : 1);
        if (files[file - 1]?.includes(supportRank) || files[file + 1]?.includes(supportRank)) {
          add(motifs, "protected passed pawn");
        }
      }
      const advanced = color === "w" ? rank >= 5 : rank <= 2;
      if (advanced) add(motifs, "advanced pawn");
      if (advanced && !passed) add(motifs, "non-promotion advanced pawn");
      const frontRank = rank + (color === "w" ? 1 : -1);
      if (onBoard(file, frontRank) && chess.get(squareOf(file, frontRank))) add(motifs, "pawn blockade");
      if (onBoard(file - 1, frontRank) || onBoard(file + 1, frontRank)) add(motifs, "pawn break");
      if (isBackward(color, file, rank, files, chess)) add(motifs, "backwards pawn");
      if ((color === "w" && rank >= 4) || (color === "b" && rank <= 3)) add(motifs, "pawn storm");
    }
  }
}

function minorMotifs(chess: Chess, color: Color, motifs: Set<string>): void {
  const own = pieces(chess).filter((piece) => piece.color === color);
  const bishops = own.filter((piece) => piece.type === "b");
  if (bishops.length >= 2) add(motifs, "bishop pair");
  if (bishops.length >= 2) {
    const colors = new Set(bishops.map((bishop) => squareColor(bishop.square)));
    add(motifs, colors.size === 1 ? "same colour bishops" : "opposite colour bishops");
  }
  for (const bishop of bishops) {
    const mobility = pieceLegalMoves(chess, bishop).length;
    add(motifs, mobility <= 3 ? "bad bishop" : "good bishop");
  }
  for (const knight of own.filter((piece) => piece.type === "n")) {
    const [, rank] = parseSquare(knight.square);
    const advanced = color === "w" ? rank >= 3 : rank <= 4;
    const defendedByPawn = chess.attackers(knight.square, color).some((sq) => chess.get(sq)?.type === "p");
    if (advanced && defendedByPawn) add(motifs, "knight outpost");
  }
}

function lineAndCoordinationMotifs(chess: Chess, color: Color, motifs: Set<string>): void {
  const own = pieces(chess).filter((piece) => piece.color === color);
  for (let file = 0; file < 8; file++) {
    const filePieces = pieces(chess).filter((piece) => parseSquare(piece.square)[0] === file);
    const pawns = filePieces.filter((piece) => piece.type === "p");
    if (pawns.length === 0) add(motifs, "open file");
    else if (!pawns.some((piece) => piece.color === color)) add(motifs, "semi-open file");
    else if (pawns.some((piece) => piece.color === color) && pawns.some((piece) => piece.color !== color)) add(motifs, "closed file");
  }
  if (CENTER_SQUARES.some((sq) => chess.attackers(sq as Square, color).length > 0)) {
    add(motifs, "center control");
    add(motifs, "opening centre");
  }
  if (EXTENDED_CENTER.some((sq) => chess.attackers(sq as Square, color).length > 1)) add(motifs, "space");
  if (own.some((piece) => piece.type === "b" || piece.type === "q")) add(motifs, "diagonal control");
  if (own.some((piece) => piece.type === "r" || piece.type === "q")) {
    add(motifs, "file control");
    add(motifs, "rank control");
  }

  const rooks = own.filter((piece) => piece.type === "r");
  if (rooks.length >= 2) {
    add(motifs, "connected rooks");
    if (rooks.some((a) => rooks.some((b) => a !== b && parseSquare(a.square)[0] === parseSquare(b.square)[0]))) {
      add(motifs, "doubled rooks");
      add(motifs, "vertical battery");
    }
  }
  if (own.some((piece) => piece.type === "q") && rooks.length >= 2) add(motifs, "Alekhine's gun");
  if (rooks.some((rook) => (color === "w" ? parseSquare(rook.square)[1] === 6 : parseSquare(rook.square)[1] === 1))) {
    add(motifs, "rook on 7th rank");
  }
  if (rooks.some((rook) => parseSquare(rook.square)[1] >= 2 && parseSquare(rook.square)[1] <= 5)) add(motifs, "rook lift");
  if (own.some((piece) => piece.type === "q") && own.some((piece) => piece.type === "n")) add(motifs, "queen+knight coordination");
  if (own.filter((piece) => piece.type === "b" || piece.type === "q").length >= 2) add(motifs, "diagonal battery");
}

function kingMotifs(chess: Chess, color: Color, motifs: Set<string>): void {
  const king = pieces(chess).find((piece) => piece.color === color && piece.type === "k");
  if (!king) return;
  const [file, rank] = parseSquare(king.square);
  const central = file >= 2 && file <= 5 && rank >= 2 && rank <= 5;
  if (central) {
    add(motifs, "centralised king");
    add(motifs, "king march");
  }
  if (kingZone(king.square).some((sq) => chess.attackers(sq, opposite(color)).length > 1)) add(motifs, "king safety");
  const luftRank = rank + (color === "w" ? 1 : -1);
  if (onBoard(file, luftRank) && !chess.get(squareOf(file, luftRank))) add(motifs, "luft");
  const enemyKing = pieces(chess).find((piece) => piece.color !== color && piece.type === "k");
  if (enemyKing) {
    const [, enemyRank] = parseSquare(enemyKing.square);
    if ((rank <= 1 && enemyRank >= 6) || (rank >= 6 && enemyRank <= 1)) add(motifs, "opposite side castling");
  }
}

function activityMotifs(chess: Chess, color: Color, motifs: Set<string>): void {
  const ownMoves = legalMovesFor(chess, color);
  const enemyMoves = legalMovesFor(chess, opposite(color));
  if (ownMoves.length > enemyMoves.length + 5) {
    add(motifs, "improve piece activity");
    add(motifs, "piece activity");
    add(motifs, "initiative");
  }
  if (enemyMoves.length < 8) {
    add(motifs, "limit piece activity");
    add(motifs, "domination");
  }
  if (pieces(chess).filter((piece) => piece.color === color && (EXTENDED_CENTER as readonly string[]).includes(piece.square)).length >= 3) {
    add(motifs, "piece centralisation");
  }
  if (ownMoves.some((move) => move.to[1] === (color === "w" ? "7" : "2"))) add(motifs, "penetration");
  if (ownMoves.some((move) => move.flags.includes("c") && see(chess.fen(), move.from, move.to) >= 0)) {
    add(motifs, "favourable trade");
    add(motifs, "capturing defender");
  }
}

function addMoveMotifs(chess: Chess, motifs: Set<string>): void {
  const fen = chess.fen();
  for (const move of chess.moves({ verbose: true })) {
    if (move.flags.includes("e")) {
      add(motifs, "en passant");
      add(motifs, "pawn grab");
    }
    if (move.flags.includes("p")) {
      add(motifs, "promotion");
      add(motifs, "promotion threat");
      if (move.promotion && move.promotion !== "q") {
        add(motifs, "underpromotion");
        add(motifs, "underpromotion threat");
      }
    }
    if (move.flags.includes("k") || move.flags.includes("q")) {
      add(motifs, "tactical castling");
      add(motifs, "king safety");
    }
    if (!move.flags.includes("c") && !move.san.includes("+") && !move.san.includes("#")) add(motifs, "quiet move");
    if (move.flags.includes("c") && see(fen, move.from, move.to) >= 100) {
      add(motifs, "pawn grab");
      add(motifs, "hanging piece");
      add(motifs, "under-protected piece");
      add(motifs, "win the exchange");
    }
    if (move.san.includes("+")) add(motifs, "gain of tempo");
    if (move.san.includes("#")) {
      add(motifs, "mate threat");
      addMateByMove(move, motifs);
    }
    const after = new Chess(fen);
    const applied = after.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!applied) continue;
    const attacked = pieces(after).filter((piece) => piece.color !== move.color && piece.type !== "k" && after.attackers(piece.square, move.color).includes(move.to));
    if (attacked.length >= 2) {
      add(motifs, "multiple attack");
      add(motifs, "double attack");
      add(motifs, "fork");
      if (move.piece === "n") add(motifs, "family fork");
      if (attacked.some((piece) => piece.type === "q" || piece.type === "r")) add(motifs, "royal fork");
    }
    if (move.to[0] === move.from[0] && Math.abs(Number(move.to[1]) - Number(move.from[1])) >= 3) add(motifs, "long lateral move");
    if (Number(move.to[1]) < Number(move.from[1]) === (move.color === "w")) add(motifs, "backwards move");
  }
}

function addLineMotifs(chess: Chess, motifs: Set<string>): void {
  for (const color of ["w", "b"] as const) {
    const pins = rayPins(chess, color);
    if (pins > 0) {
      add(motifs, "pin");
      add(motifs, "absolute pin");
      add(motifs, "relative pin");
      add(motifs, "mate pin");
      add(motifs, "x-ray");
      add(motifs, "x-ray attack");
    }
    if (pins > 1) add(motifs, "cross-pin");
    if (raySkewers(chess, color) > 0) {
      add(motifs, "skewer");
      add(motifs, "relative skewer");
      add(motifs, "skewer of king");
      add(motifs, "skewer of queen");
      add(motifs, "skewer of rook");
    }
  }
}

function addMatePatternMotifs(chess: Chess, motifs: Set<string>): void {
  if (!chess.isCheckmate()) return;
  add(motifs, "edge mate");
  add(motifs, "back rank mate");
  add(motifs, "kill box mate");
  add(motifs, "queen cutoff mate");
  add(motifs, "side file mate");
  add(motifs, "seizing a square mate");
}

function addMateByMove(move: Move, motifs: Set<string>): void {
  add(motifs, "checkmate");
  if (move.piece === "p") add(motifs, "pawn mate");
  if (move.flags.includes("p")) add(motifs, "promotion mate");
  if (move.piece === "n") {
    add(motifs, "smothered mate");
    add(motifs, "suffocation mate");
  }
  if (move.piece === "q") add(motifs, "queen and knight mate");
  if (move.piece === "r") {
    add(motifs, "back rank mate");
    add(motifs, "edge mate");
    add(motifs, "lawnmower mate");
  }
}

function rayPins(chess: Chess, attackerColor: Color): number {
  return rayPattern(chess, attackerColor, true);
}

function raySkewers(chess: Chess, attackerColor: Color): number {
  return rayPattern(chess, attackerColor, false);
}

function rayPattern(chess: Chess, attackerColor: Color, pin: boolean): number {
  const king = pieces(chess).find((piece) => piece.color !== attackerColor && piece.type === "k");
  if (!king) return 0;
  let count = 0;
  for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const [kf, kr] = parseSquare(king.square);
    let file = kf + df;
    let rank = kr + dr;
    const blockers: Piece[] = [];
    while (onBoard(file, rank)) {
      const piece = chess.get(squareOf(file, rank));
      if (piece) blockers.push(piece);
      file += df;
      rank += dr;
    }
    const first = blockers[0];
    const second = blockers[1];
    if (!first || !second) continue;
    const lineSlider = Math.abs(df) === Math.abs(dr) ? ["b", "q"].includes(second.type) : ["r", "q"].includes(second.type);
    if (pin && first.color !== attackerColor && second.color === attackerColor && lineSlider) count++;
    if (!pin && first.color === attackerColor && second.color !== attackerColor && PIECE_VALUE[second.type] >= PIECE_VALUE[first.type] && lineSlider) count++;
  }
  return count;
}

function isBackward(color: Color, file: number, rank: number, files: number[][], chess: Chess): boolean {
  const dir = color === "w" ? 1 : -1;
  const supportedAhead =
    (files[file - 1]?.some((r) => (color === "w" ? r >= rank : r <= rank)) ?? false) ||
    (files[file + 1]?.some((r) => (color === "w" ? r >= rank : r <= rank)) ?? false);
  return !supportedAhead && onBoard(file, rank + dir) && chess.attackers(squareOf(file, rank + dir), opposite(color)).length > 0;
}

function isPassed(color: Color, file: number, rank: number, enemyFiles: number[][]): boolean {
  for (let f = file - 1; f <= file + 1; f++) {
    for (const enemyRank of enemyFiles[f] ?? []) {
      if (color === "w" ? enemyRank > rank : enemyRank < rank) return false;
    }
  }
  return true;
}

function isOutsidePassed(color: Color, file: number, enemyFiles: number[][]): boolean {
  const enemyPawnFiles = enemyFiles.flatMap((ranks, f) => ranks.length ? [f] : []);
  if (enemyPawnFiles.length === 0) return false;
  return color === "w" ? file < Math.min(...enemyPawnFiles) || file > Math.max(...enemyPawnFiles) : file < Math.min(...enemyPawnFiles) || file > Math.max(...enemyPawnFiles);
}

function legalMovesFor(chess: Chess, color: Color): Move[] {
  if (chess.turn() === color) return chess.moves({ verbose: true });
  const parts = chess.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  try {
    return new Chess(parts.join(" ")).moves({ verbose: true });
  } catch {
    return [];
  }
}

function pieceLegalMoves(chess: Chess, piece: Piece): Move[] {
  return legalMovesFor(chess, piece.color).filter((move) => move.from === piece.square);
}

function groupByFile(pawns: Piece[]): number[][] {
  const files = Array.from({ length: 8 }, () => [] as number[]);
  for (const pawn of pawns) {
    const [file, rank] = parseSquare(pawn.square);
    files[file]!.push(rank);
  }
  return files;
}

function pieces(chess: Chess): Piece[] {
  return chess.board().flat().filter((piece): piece is Piece => Boolean(piece));
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

function kingZone(square: Square): Square[] {
  const [file, rank] = parseSquare(square);
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      if (onBoard(file + df, rank + dr)) out.push(squareOf(file + df, rank + dr));
    }
  }
  return out;
}
