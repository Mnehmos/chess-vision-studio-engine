import type { Color, PieceSymbol, Square } from "./chess.js";

export type { Color, PieceSymbol, Square };

export type GamePhase = "opening" | "middlegame" | "endgame";
export type ScorePerspective = "white" | "side-to-move" | "reference";
export type DatasetPurpose = "fit" | "tuning" | "validation" | "release-test";
export type TerminalClass = "ongoing" | "checkmate" | "stalemate" | "draw";
export type TablebaseClass = "candidate-7-piece" | "out-of-scope" | "unknown";

/**
 * Position-level features. This mirrors the `features` block produced by the
 * Chess Vision Studio export so a CVS analysis ply can be turned into a
 * {@link TrainingPosition} with minimal glue.
 */
export interface PositionFeatures {
  phase: GamePhase;
  /** Material balance in centipawns, from White's perspective. */
  materialBalance: number;
  kingPressureWhite: number;
  kingPressureBlack: number;
  loosePiecesWhite: number;
  loosePiecesBlack: number;
  hangingValueWhite: number;
  hangingValueBlack: number;
  centerControlWhite: number;
  centerControlBlack: number;
  mobilityWhite: number;
  mobilityBlack: number;
  safeMovesWhite: number;
  safeMovesBlack: number;
  motifs: string[];
}

/**
 * Per-legal-move features consumed by the policy ranker. Every field is either
 * a 0/1 indicator or a centipawn-scaled scalar so a single linear model can mix
 * them. Feature names are stable: they are the keys of the weight vector.
 */
export interface MoveFeatures {
  isCapture: number;
  isCheck: number;
  isPromotion: number;
  isCastle: number;
  isEnPassant: number;
  /** Static Exchange Evaluation of the destination square, in centipawns. */
  see: number;
  /** Centipawn value of the captured piece (0 for a quiet move). */
  captureValue: number;
  /** 1 when the moved piece was attacked on its origin square (a possible escape). */
  escapesAttack: number;
  /** 1 when the destination square is attacked by the opponent and under-defended. */
  movesIntoDanger: number;
  /** Change in the mover's piece-square value (destination minus origin), centipawns. */
  pstDelta: number;
  /** 1 for a minor piece leaving its starting (back-rank) square. */
  develops: number;
  /** 1 when the moved piece attacks one or more squares in the opponent king zone. */
  attacksKingZone: number;
  /** 1 when the destination is an extended-center square (c3..f6 box). */
  movesToCenter: number;
  /** Number of opponent pieces attacked by the moved piece from its destination. */
  createsThreat: number;
}

export const MOVE_FEATURE_KEYS: (keyof MoveFeatures)[] = [
  "isCapture",
  "isCheck",
  "isPromotion",
  "isCastle",
  "isEnPassant",
  "see",
  "captureValue",
  "escapesAttack",
  "movesIntoDanger",
  "pstDelta",
  "develops",
  "attacksKingZone",
  "movesToCenter",
  "createsThreat",
];

/** A scored candidate move emitted by the policy engine. */
export interface CandidateMove {
  san: string;
  uci: string;
  from: Square;
  to: Square;
  /** Raw linear score (logit) before softmax. */
  score: number;
  /** Softmax probability across the legal-move set. */
  prob: number;
  features: MoveFeatures;
}

export interface EngineMove {
  san: string;
  uci: string;
}

/** Result of a full policy+value+search analysis of a position. */
export interface AnalysisResult {
  fen: string;
  bestMove: EngineMove | null;
  /** Search score in centipawns, from the side-to-move's perspective. */
  scoreCp: number;
  /** Mate distance in plies if a forced mate was found (sign = who mates). */
  mate?: number;
  /** Principal variation as UCI strings. */
  pv: string[];
  /** Root search alternatives when requested through multiPv. */
  multiPv: {
    move: EngineMove;
    scoreCp: number;
    mate?: number;
    pv: string[];
  }[];
  depth: number;
  seldepth: number;
  nodes: number;
  hashfull: number;
  aborted: boolean;
  abortReason?: "time" | "nodes" | "stop";
  /** Initial root move order as UCI strings, when requested for diagnostics. */
  rootMoveOrder?: string[];
  /** Static value-engine evaluation of the root, White's perspective (centipawns). */
  staticEval: number;
  /** Policy candidate ranking for the root position. */
  policy: CandidateMove[];
}

/**
 * One labelled tuning example: a position plus everything known about it. This
 * is the schema used by the classical policy-weight fitter.
 */
export interface TrainingPosition {
  fen: string;
  sideToMove: Color;
  legalMoves: string[];
  playedMove: string;
  bestMove?: string;
  topMoves?: {
    san: string;
    uci: string;
    cp?: number;
    mate?: number;
    depth: number;
    multipv?: number;
    nodes?: number;
    engine?: string;
    engineVersion?: string;
    hashMb?: number;
    tablebase?: string;
    scorePerspective?: ScorePerspective;
  }[];
  /** Perspective used by centipawn scores in this row. Default is White. */
  scorePerspective?: ScorePerspective;
  /** Dataset split/purpose, used to keep fitting data away from release gates. */
  suitePurpose?: DatasetPurpose;
  /** Optional tablebase classification from the data producer. */
  tablebaseClass?: TablebaseClass;
  evalBefore?: number;
  evalAfterPlayed?: number;
  evalAfterBest?: number;
  cpLoss?: number;
  classification?: string;
  features: PositionFeatures;
  result?: "1-0" | "0-1" | "1/2-1/2";
  playerElo?: number;
  source: "my_game" | "master_game" | "stockfish_selfplay" | "bot_game";
}

/**
 * A flattened tuning row: one legal move from one position, with a label.
 * This is the Phase 3 ranking dataset — the played/best move is label 1, the
 * rest are label 0 (or a soft target).
 */
export interface MoveTrainingRow {
  fen: string;
  uci: string;
  san: string;
  label: number;
  features: MoveFeatures;
}
