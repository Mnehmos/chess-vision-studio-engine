export type Color = "w" | "b";
export type PieceSymbol = "p" | "n" | "b" | "r" | "q" | "k";
export type FileChar = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export type RankChar = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type Square = `${FileChar}${RankChar}`;

export interface Piece {
  type: PieceSymbol;
  color: Color;
  square: Square;
}

export interface Move {
  color: Color;
  from: Square;
  to: Square;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  flags: string;
  san: string;
  lan: string;
  before: string;
  after: string;
}

interface BoardPiece {
  type: PieceSymbol;
  color: Color;
}

interface DraftMove {
  color: Color;
  from: Square;
  to: Square;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  flags: string;
}

interface CastlingRights {
  K: boolean;
  Q: boolean;
  k: boolean;
  q: boolean;
}

interface State {
  board: (BoardPiece | null)[];
  sideToMove: Color;
  castling: CastlingRights;
  epSquare: Square | null;
  halfmoveClock: number;
  fullmoveNumber: number;
}

interface HistoryEntry {
  state: State;
  move: Move;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const PROMOTIONS: PieceSymbol[] = ["q", "r", "b", "n"];
const PIECE_LETTER: Record<Exclude<PieceSymbol, "p">, string> = {
  n: "N",
  b: "B",
  r: "R",
  q: "Q",
  k: "K",
};

const KNIGHT_DELTAS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;

const KING_DELTAS = [
  [1, 1],
  [1, 0],
  [1, -1],
  [0, 1],
  [0, -1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const QUEEN_DIRS = [...BISHOP_DIRS, ...ROOK_DIRS] as const;

export class Chess {
  private boardState: (BoardPiece | null)[] = new Array<BoardPiece | null>(64).fill(null);
  private sideToMove: Color = "w";
  private castling: CastlingRights = { K: true, Q: true, k: true, q: true };
  private epSquare: Square | null = null;
  private halfmoveClock = 0;
  private fullmoveNumber = 1;
  private history: HistoryEntry[] = [];

  constructor(fen = START_FEN) {
    this.loadFen(fen);
    this.validatePosition();
  }

  fen(): string {
    const rows: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = "";
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.pieceAt(indexOf(file, rank));
        if (!piece) {
          empty++;
          continue;
        }
        if (empty > 0) {
          row += String(empty);
          empty = 0;
        }
        const letter = piece.type === "n" ? "n" : piece.type;
        row += piece.color === "w" ? letter.toUpperCase() : letter;
      }
      if (empty > 0) row += String(empty);
      rows.push(row);
    }

    return [
      rows.join("/"),
      this.sideToMove,
      this.castlingFen(),
      this.visibleEpSquare() ?? "-",
      String(this.halfmoveClock),
      String(this.fullmoveNumber),
    ].join(" ");
  }

  /** Compact, allocation-light state fields for engine internals. */
  engineState(): {
    pieces: readonly (BoardPiece | null)[];
    sideToMove: Color;
    castling: Readonly<CastlingRights>;
    epSquare: Square | null;
  } {
    return {
      pieces: this.boardState,
      sideToMove: this.sideToMove,
      castling: this.castling,
      epSquare: this.visibleEpSquare(),
    };
  }

  turn(): Color {
    return this.sideToMove;
  }

  board(): (Piece | null)[][] {
    const rows: (Piece | null)[][] = [];
    for (let rank = 7; rank >= 0; rank--) {
      const row: (Piece | null)[] = [];
      for (let file = 0; file < 8; file++) {
        const square = squareOf(file, rank);
        const piece = this.pieceAt(indexOf(file, rank));
        row.push(piece ? { ...piece, square } : null);
      }
      rows.push(row);
    }
    return rows;
  }

  get(square: Square): Piece | null {
    const [file, rank] = parseSquare(square);
    const piece = this.pieceAt(indexOf(file, rank));
    return piece ? { ...piece, square } : null;
  }

  put(piece: { type: PieceSymbol; color: Color }, square: Square): boolean {
    const [file, rank] = parseSquare(square);
    this.boardState[indexOf(file, rank)] = { type: piece.type, color: piece.color };
    return true;
  }

  remove(square: Square): Piece | null {
    const [file, rank] = parseSquare(square);
    const idx = indexOf(file, rank);
    const piece = this.pieceAt(idx);
    this.boardState[idx] = null;
    return piece ? { ...piece, square } : null;
  }

  attackers(square: Square, color: Color): Square[] {
    const [file, rank] = parseSquare(square);
    const out: Square[] = [];

    const pawnRank = color === "w" ? rank - 1 : rank + 1;
    for (const df of [-1, 1]) {
      const fromFile = file + df;
      if (!onBoard(fromFile, pawnRank)) continue;
      const from = indexOf(fromFile, pawnRank);
      const piece = this.pieceAt(from);
      if (piece?.color === color && piece.type === "p") out.push(squareOf(fromFile, pawnRank));
    }

    for (const [df, dr] of KNIGHT_DELTAS) {
      const fromFile = file + df;
      const fromRank = rank + dr;
      if (!onBoard(fromFile, fromRank)) continue;
      const piece = this.pieceAt(indexOf(fromFile, fromRank));
      if (piece?.color === color && piece.type === "n") out.push(squareOf(fromFile, fromRank));
    }

    for (const [df, dr] of KING_DELTAS) {
      const fromFile = file + df;
      const fromRank = rank + dr;
      if (!onBoard(fromFile, fromRank)) continue;
      const piece = this.pieceAt(indexOf(fromFile, fromRank));
      if (piece?.color === color && piece.type === "k") out.push(squareOf(fromFile, fromRank));
    }

    for (const [df, dr] of BISHOP_DIRS) {
      this.collectSlidingAttacker(out, color, file, rank, df, dr, new Set<PieceSymbol>(["b", "q"]));
    }
    for (const [df, dr] of ROOK_DIRS) {
      this.collectSlidingAttacker(out, color, file, rank, df, dr, new Set<PieceSymbol>(["r", "q"]));
    }

    return out;
  }

  moves(options?: { verbose?: false }): string[];
  moves(options: { verbose: true; san?: boolean; fen?: boolean }): Move[];
  moves(options: { verbose?: boolean; san?: boolean; fen?: boolean } = {}): string[] | Move[] {
    const moves = this.legalMoves({
      san: options.san,
      fen: options.fen,
    });
    return options.verbose ? moves : moves.map((m) => m.san);
  }

  move(move: { from: string; to: string; promotion?: string }): Move | null {
    const from = normaliseSquare(move.from);
    const to = normaliseSquare(move.to);
    const promotion = move.promotion ? normalisePromotion(move.promotion) : undefined;
    const legal = this.legalMoves();
    const selected = legal.find(
      (m) =>
        m.from === from &&
        m.to === to &&
        (m.promotion === promotion || (!promotion && m.promotion === "q") || (!promotion && !m.promotion)),
    );
    if (!selected) return null;

    const state = this.snapshot();
    this.applyDraft(selected);
    this.history.push({ state, move: selected });
    return selected;
  }

  /** Apply a legal move previously produced by moves({ verbose: true }). */
  push(move: Move): Move {
    const state = this.snapshot();
    this.applyDraft(move);
    this.history.push({ state, move });
    return move;
  }

  undo(): Move | null {
    const entry = this.history.pop();
    if (!entry) return null;
    this.restore(entry.state);
    return entry.move;
  }

  inCheck(): boolean {
    return this.isKingAttacked(this.sideToMove);
  }

  isCheckmate(): boolean {
    return this.inCheck() && this.legalDrafts(this.sideToMove).length === 0;
  }

  isStalemate(): boolean {
    return !this.inCheck() && this.legalDrafts(this.sideToMove).length === 0;
  }

  isInsufficientMaterial(): boolean {
    const pieces: { piece: BoardPiece; square: Square }[] = [];
    for (let i = 0; i < 64; i++) {
      const piece = this.pieceAt(i);
      if (piece && piece.type !== "k") pieces.push({ piece, square: squareAt(i) });
    }
    if (pieces.length === 0) return true;
    if (pieces.some(({ piece }) => piece.type === "p" || piece.type === "r" || piece.type === "q")) {
      return false;
    }
    if (pieces.length === 1) return true;
    if (pieces.every(({ piece }) => piece.type === "b")) {
      const colours = new Set(pieces.map(({ square }) => squareColour(square)));
      return colours.size === 1;
    }
    if (pieces.every(({ piece }) => piece.type === "n") && pieces.length <= 2) return true;
    return false;
  }

  isDraw(): boolean {
    return this.halfmoveClock >= 100 || this.isInsufficientMaterial() || this.isStalemate();
  }

  isGameOver(): boolean {
    return this.isCheckmate() || this.isDraw();
  }

  private loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error("Invalid FEN: expected at least 4 fields");

    this.boardState = new Array<BoardPiece | null>(64).fill(null);
    this.loadBoard(parts[0]!);
    this.sideToMove = parseColor(parts[1]!);
    this.castling = parseCastling(parts[2]!);
    this.epSquare = parts[3] === "-" ? null : normaliseSquare(parts[3]!);
    this.halfmoveClock = parts[4] ? parseFenInteger(parts[4]!, "halfmove clock") : 0;
    this.fullmoveNumber = parts[5] ? Math.max(1, parseFenInteger(parts[5]!, "fullmove number")) : 1;
    this.history = [];
  }

  private loadBoard(boardFen: string): void {
    const rows = boardFen.split("/");
    if (rows.length !== 8) throw new Error("Invalid FEN: board must have 8 ranks");

    for (let row = 0; row < 8; row++) {
      const rank = 7 - row;
      let file = 0;
      for (const char of rows[row]!) {
        if (/^[1-8]$/.test(char)) {
          file += Number.parseInt(char, 10);
          continue;
        }
        if (file > 7) throw new Error("Invalid FEN: too many files in rank");
        const piece = pieceFromFen(char);
        this.boardState[indexOf(file, rank)] = piece;
        file++;
      }
      if (file !== 8) throw new Error("Invalid FEN: rank does not contain 8 files");
    }
  }

  private validatePosition(): void {
    const whiteKing = this.kingSquare("w");
    const blackKing = this.kingSquare("b");
    if (!whiteKing || !blackKing) throw new Error("Invalid FEN: missing king");
    if (this.attackers(whiteKing, "b").includes(blackKing)) throw new Error("Invalid FEN: adjacent kings");
    if (this.isKingAttacked(opposite(this.sideToMove))) {
      throw new Error("Invalid FEN: side not to move is in check");
    }
  }

  private legalMoves(options: { san?: boolean; fen?: boolean } = {}): Move[] {
    const includeSan = options.san !== false;
    const includeFen = options.fen !== false || includeSan;
    const drafts = this.legalDrafts(this.sideToMove);
    const before = includeFen ? this.fen() : "";
    const moves = drafts.map((draft) => {
      let after = "";
      if (includeFen) {
        const state = this.snapshot();
        this.applyDraft(draft);
        after = this.fen();
        this.restore(state);
      }
      return {
        ...draft,
        san: "",
        lan: `${draft.from}${draft.to}${draft.promotion ?? ""}`,
        before,
        after,
      };
    });

    if (includeSan) {
      for (const move of moves) {
        move.san = this.sanFor(move, moves);
      }
    }
    return moves;
  }

  private legalDrafts(color: Color): DraftMove[] {
    const out: DraftMove[] = [];
    for (const move of this.pseudoDrafts(color)) {
      const state = this.snapshot();
      this.applyDraft(move);
      const illegal = this.isKingAttacked(color);
      this.restore(state);
      if (!illegal) out.push(move);
    }
    return out;
  }

  private pseudoDrafts(color: Color): DraftMove[] {
    const moves: DraftMove[] = [];
    for (let idx = 0; idx < 64; idx++) {
      const piece = this.pieceAt(idx);
      if (!piece || piece.color !== color) continue;
      const from = squareAt(idx);
      const file = idx % 8;
      const rank = Math.floor(idx / 8);

      if (piece.type === "p") this.addPawnDrafts(moves, piece, from, file, rank);
      else if (piece.type === "n") this.addStepDrafts(moves, piece, from, file, rank, KNIGHT_DELTAS);
      else if (piece.type === "b") this.addSliderDrafts(moves, piece, from, file, rank, BISHOP_DIRS);
      else if (piece.type === "r") this.addSliderDrafts(moves, piece, from, file, rank, ROOK_DIRS);
      else if (piece.type === "q") this.addSliderDrafts(moves, piece, from, file, rank, QUEEN_DIRS);
      else this.addKingDrafts(moves, piece, from, file, rank);
    }
    return moves;
  }

  private addPawnDrafts(
    moves: DraftMove[],
    piece: BoardPiece,
    from: Square,
    file: number,
    rank: number,
  ): void {
    const dir = piece.color === "w" ? 1 : -1;
    const startRank = piece.color === "w" ? 1 : 6;
    const promotionRank = piece.color === "w" ? 7 : 0;
    const oneRank = rank + dir;

    if (onBoard(file, oneRank) && !this.pieceAt(indexOf(file, oneRank))) {
      const to = squareOf(file, oneRank);
      if (oneRank === promotionRank) {
        for (const promotion of PROMOTIONS) moves.push({ color: piece.color, from, to, piece: "p", promotion, flags: "p" });
      } else {
        moves.push({ color: piece.color, from, to, piece: "p", flags: "n" });
        const twoRank = rank + dir * 2;
        if (rank === startRank && onBoard(file, twoRank) && !this.pieceAt(indexOf(file, twoRank))) {
          moves.push({ color: piece.color, from, to: squareOf(file, twoRank), piece: "p", flags: "b" });
        }
      }
    }

    for (const df of [-1, 1]) {
      const toFile = file + df;
      const toRank = rank + dir;
      if (!onBoard(toFile, toRank)) continue;
      const to = squareOf(toFile, toRank);
      const target = this.pieceAt(indexOf(toFile, toRank));
      if (target && target.color !== piece.color && target.type !== "k") {
        if (toRank === promotionRank) {
          for (const promotion of PROMOTIONS) {
            moves.push({
              color: piece.color,
              from,
              to,
              piece: "p",
              captured: target.type,
              promotion,
              flags: "cp",
            });
          }
        } else {
          moves.push({ color: piece.color, from, to, piece: "p", captured: target.type, flags: "c" });
        }
      }

      if (this.epSquare === to && !target) {
        const capturedRank = piece.color === "w" ? toRank - 1 : toRank + 1;
        const captured = this.pieceAt(indexOf(toFile, capturedRank));
        if (captured?.type === "p" && captured.color !== piece.color) {
          moves.push({ color: piece.color, from, to, piece: "p", captured: "p", flags: "e" });
        }
      }
    }
  }

  private addStepDrafts(
    moves: DraftMove[],
    piece: BoardPiece,
    from: Square,
    file: number,
    rank: number,
    deltas: readonly (readonly [number, number])[],
  ): void {
    for (const [df, dr] of deltas) {
      const toFile = file + df;
      const toRank = rank + dr;
      if (!onBoard(toFile, toRank)) continue;
      const target = this.pieceAt(indexOf(toFile, toRank));
      if (!target) {
        moves.push({ color: piece.color, from, to: squareOf(toFile, toRank), piece: piece.type, flags: "n" });
      } else if (target.color !== piece.color && target.type !== "k") {
        moves.push({
          color: piece.color,
          from,
          to: squareOf(toFile, toRank),
          piece: piece.type,
          captured: target.type,
          flags: "c",
        });
      }
    }
  }

  private addSliderDrafts(
    moves: DraftMove[],
    piece: BoardPiece,
    from: Square,
    file: number,
    rank: number,
    dirs: readonly (readonly [number, number])[],
  ): void {
    for (const [df, dr] of dirs) {
      let toFile = file + df;
      let toRank = rank + dr;
      while (onBoard(toFile, toRank)) {
        const target = this.pieceAt(indexOf(toFile, toRank));
        const to = squareOf(toFile, toRank);
        if (!target) {
          moves.push({ color: piece.color, from, to, piece: piece.type, flags: "n" });
        } else {
          if (target.color !== piece.color && target.type !== "k") {
            moves.push({ color: piece.color, from, to, piece: piece.type, captured: target.type, flags: "c" });
          }
          break;
        }
        toFile += df;
        toRank += dr;
      }
    }
  }

  private addKingDrafts(
    moves: DraftMove[],
    piece: BoardPiece,
    from: Square,
    file: number,
    rank: number,
  ): void {
    this.addStepDrafts(moves, piece, from, file, rank, KING_DELTAS);
    this.addCastlingDrafts(moves, piece.color);
  }

  private addCastlingDrafts(moves: DraftMove[], color: Color): void {
    const rank = color === "w" ? 0 : 7;
    const kingFrom = squareOf(4, rank);
    const king = this.get(kingFrom);
    if (!king || king.type !== "k" || king.color !== color) return;
    if (this.isKingAttacked(color)) return;

    const enemy = opposite(color);
    const kingSideRight = color === "w" ? this.castling.K : this.castling.k;
    const queenSideRight = color === "w" ? this.castling.Q : this.castling.q;

    if (
      kingSideRight &&
      this.rookAt(7, rank, color) &&
      !this.pieceAt(indexOf(5, rank)) &&
      !this.pieceAt(indexOf(6, rank)) &&
      !this.isSquareAttacked(squareOf(5, rank), enemy) &&
      !this.isSquareAttacked(squareOf(6, rank), enemy)
    ) {
      moves.push({ color, from: kingFrom, to: squareOf(6, rank), piece: "k", flags: "k" });
    }

    if (
      queenSideRight &&
      this.rookAt(0, rank, color) &&
      !this.pieceAt(indexOf(1, rank)) &&
      !this.pieceAt(indexOf(2, rank)) &&
      !this.pieceAt(indexOf(3, rank)) &&
      !this.isSquareAttacked(squareOf(3, rank), enemy) &&
      !this.isSquareAttacked(squareOf(2, rank), enemy)
    ) {
      moves.push({ color, from: kingFrom, to: squareOf(2, rank), piece: "k", flags: "q" });
    }
  }

  private applyDraft(move: DraftMove): void {
    const [fromFile, fromRank] = parseSquare(move.from);
    const [toFile, toRank] = parseSquare(move.to);
    const fromIdx = indexOf(fromFile, fromRank);
    const toIdx = indexOf(toFile, toRank);
    const piece = this.pieceAt(fromIdx);
    if (!piece) throw new Error(`No piece on ${move.from}`);

    const target = this.pieceAt(toIdx);
    if (move.flags.includes("e")) {
      const capturedRank = piece.color === "w" ? toRank - 1 : toRank + 1;
      this.boardState[indexOf(toFile, capturedRank)] = null;
    }

    this.boardState[fromIdx] = null;
    this.boardState[toIdx] = { type: move.promotion ?? piece.type, color: piece.color };

    if (move.flags.includes("k")) {
      this.moveRookForCastle(7, 5, fromRank);
    } else if (move.flags.includes("q")) {
      this.moveRookForCastle(0, 3, fromRank);
    }

    this.updateCastlingRights(move, piece, target);
    this.epSquare = move.flags.includes("b") ? squareOf(fromFile, (fromRank + toRank) / 2) : null;
    this.halfmoveClock = piece.type === "p" || move.captured ? 0 : this.halfmoveClock + 1;
    if (this.sideToMove === "b") this.fullmoveNumber++;
    this.sideToMove = opposite(this.sideToMove);
  }

  private sanFor(move: Move, legalMoves: Move[]): string {
    if (move.flags.includes("k")) return this.withCheckSuffix("O-O", move);
    if (move.flags.includes("q")) return this.withCheckSuffix("O-O-O", move);

    const capture = move.flags.includes("c") || move.flags.includes("e");
    let san = "";

    if (move.piece === "p") {
      if (capture) san += move.from[0];
    } else {
      san += PIECE_LETTER[move.piece];
      san += this.disambiguation(move, legalMoves);
    }

    if (capture) san += "x";
    san += move.to;
    if (move.promotion) san += `=${PIECE_LETTER[move.promotion as Exclude<PieceSymbol, "p">]}`;

    return this.withCheckSuffix(san, move);
  }

  private withCheckSuffix(san: string, move: DraftMove): string {
    const state = this.snapshot();
    this.applyDraft(move);
    const check = this.inCheck();
    const mate = check && this.legalDrafts(this.sideToMove).length === 0;
    this.restore(state);
    return `${san}${mate ? "#" : check ? "+" : ""}`;
  }

  private disambiguation(move: Move, legalMoves: Move[]): string {
    const ambiguous = legalMoves.filter(
      (other) =>
        other !== move &&
        other.piece === move.piece &&
        other.to === move.to &&
        other.from !== move.from,
    );
    if (ambiguous.length === 0) return "";

    const [file, rank] = parseSquare(move.from);
    const sameFile = ambiguous.some((other) => parseSquare(other.from)[0] === file);
    const sameRank = ambiguous.some((other) => parseSquare(other.from)[1] === rank);
    if (!sameFile) return move.from[0]!;
    if (!sameRank) return move.from[1]!;
    return move.from;
  }

  private updateCastlingRights(move: DraftMove, piece: BoardPiece, target: BoardPiece | null): void {
    if (piece.type === "k") {
      if (piece.color === "w") {
        this.castling.K = false;
        this.castling.Q = false;
      } else {
        this.castling.k = false;
        this.castling.q = false;
      }
    }

    if (piece.type === "r") this.clearRookCastlingRight(move.from);
    if (target?.type === "r") this.clearRookCastlingRight(move.to);
  }

  private clearRookCastlingRight(square: Square): void {
    if (square === "h1") this.castling.K = false;
    else if (square === "a1") this.castling.Q = false;
    else if (square === "h8") this.castling.k = false;
    else if (square === "a8") this.castling.q = false;
  }

  private moveRookForCastle(fromFile: number, toFile: number, rank: number): void {
    const fromIdx = indexOf(fromFile, rank);
    const toIdx = indexOf(toFile, rank);
    const rook = this.pieceAt(fromIdx);
    this.boardState[fromIdx] = null;
    this.boardState[toIdx] = rook;
  }

  private rookAt(file: number, rank: number, color: Color): boolean {
    const piece = this.pieceAt(indexOf(file, rank));
    return piece?.type === "r" && piece.color === color;
  }

  private kingSquare(color: Color): Square | null {
    for (let idx = 0; idx < 64; idx++) {
      const piece = this.pieceAt(idx);
      if (piece?.type === "k" && piece.color === color) return squareAt(idx);
    }
    return null;
  }

  private isKingAttacked(color: Color): boolean {
    const king = this.kingSquare(color);
    return king ? this.isSquareAttacked(king, opposite(color)) : false;
  }

  private isSquareAttacked(square: Square, byColor: Color): boolean {
    return this.attackers(square, byColor).length > 0;
  }

  private collectSlidingAttacker(
    out: Square[],
    color: Color,
    file: number,
    rank: number,
    df: number,
    dr: number,
    types: Set<PieceSymbol>,
  ): void {
    let fromFile = file + df;
    let fromRank = rank + dr;
    while (onBoard(fromFile, fromRank)) {
      const piece = this.pieceAt(indexOf(fromFile, fromRank));
      if (piece) {
        if (piece.color === color && types.has(piece.type)) out.push(squareOf(fromFile, fromRank));
        break;
      }
      fromFile += df;
      fromRank += dr;
    }
  }

  private castlingFen(): string {
    const out =
      `${this.castling.K ? "K" : ""}${this.castling.Q ? "Q" : ""}` +
      `${this.castling.k ? "k" : ""}${this.castling.q ? "q" : ""}`;
    return out || "-";
  }

  private visibleEpSquare(): Square | null {
    if (!this.epSquare) return null;
    const [file, rank] = parseSquare(this.epSquare);
    const pawnRank = this.sideToMove === "w" ? rank - 1 : rank + 1;
    for (const df of [-1, 1]) {
      const fromFile = file + df;
      if (!onBoard(fromFile, pawnRank)) continue;
      const piece = this.pieceAt(indexOf(fromFile, pawnRank));
      if (piece?.type === "p" && piece.color === this.sideToMove) return this.epSquare;
    }
    return null;
  }

  private pieceAt(index: number): BoardPiece | null {
    return this.boardState[index] ?? null;
  }

  private snapshot(): State {
    return {
      board: this.boardState.slice(),
      sideToMove: this.sideToMove,
      castling: { ...this.castling },
      epSquare: this.epSquare,
      halfmoveClock: this.halfmoveClock,
      fullmoveNumber: this.fullmoveNumber,
    };
  }

  private restore(state: State): void {
    this.boardState = state.board;
    this.sideToMove = state.sideToMove;
    this.castling = { ...state.castling };
    this.epSquare = state.epSquare;
    this.halfmoveClock = state.halfmoveClock;
    this.fullmoveNumber = state.fullmoveNumber;
  }
}

function pieceFromFen(char: string): BoardPiece {
  const lower = char.toLowerCase();
  if (!["p", "n", "b", "r", "q", "k"].includes(lower)) {
    throw new Error(`Invalid FEN: invalid piece ${char}`);
  }
  return {
    type: lower as PieceSymbol,
    color: char === lower ? "b" : "w",
  };
}

function parseColor(value: string): Color {
  if (value !== "w" && value !== "b") throw new Error("Invalid FEN: side to move must be w or b");
  return value;
}

function parseCastling(value: string): CastlingRights {
  if (value === "-") return { K: false, Q: false, k: false, q: false };
  if (!/^[KQkq]+$/.test(value)) throw new Error("Invalid FEN: invalid castling rights");
  return {
    K: value.includes("K"),
    Q: value.includes("Q"),
    k: value.includes("k"),
    q: value.includes("q"),
  };
}

function parseFenInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid FEN: invalid ${label}`);
  return Number.parseInt(value, 10);
}

function normaliseSquare(value: string): Square {
  const square = value.toLowerCase();
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid square: ${value}`);
  return square as Square;
}

function normalisePromotion(value: string): PieceSymbol {
  const promotion = value.toLowerCase();
  if (!["q", "r", "b", "n"].includes(promotion)) throw new Error(`Invalid promotion: ${value}`);
  return promotion as PieceSymbol;
}

function parseSquare(square: Square): [number, number] {
  return [square.charCodeAt(0) - 97, Number.parseInt(square[1]!, 10) - 1];
}

function squareAt(index: number): Square {
  return squareOf(index % 8, Math.floor(index / 8));
}

function squareOf(file: number, rank: number): Square {
  return `${FILES[file]!}${rank + 1}` as Square;
}

function indexOf(file: number, rank: number): number {
  return rank * 8 + file;
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function squareColour(square: Square): "light" | "dark" {
  const [file, rank] = parseSquare(square);
  return (file + rank) % 2 === 0 ? "dark" : "light";
}
