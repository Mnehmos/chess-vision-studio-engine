import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "../chess.js";
import { extractPositionFeatures } from "../features/positionFeatures.js";
import { featuresForAllMoves } from "../features/moveFeatures.js";
import type { MoveTrainingRow, TrainingPosition } from "../types.js";

/** Parse a JSONL string into labelled tuning positions (blank lines ignored). */
export function parseJsonl(text: string): TrainingPosition[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TrainingPosition);
}

/** Serialise labelled tuning positions to JSONL (one object per line). */
export function stringifyJsonl(positions: TrainingPosition[]): string {
  return positions.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

export function loadDataset(path: string): TrainingPosition[] {
  return parseJsonl(readFileSync(path, "utf8"));
}

export function saveDataset(path: string, positions: TrainingPosition[]): void {
  writeFileSync(path, stringifyJsonl(positions), "utf8");
}

export interface BuildExampleOptions {
  bestMove?: string;
  topMoves?: TrainingPosition["topMoves"];
  evalBefore?: number;
  evalAfterPlayed?: number;
  evalAfterBest?: number;
  cpLoss?: number;
  classification?: string;
  scorePerspective?: TrainingPosition["scorePerspective"];
  suitePurpose?: TrainingPosition["suitePurpose"];
  tablebaseClass?: TrainingPosition["tablebaseClass"];
  result?: TrainingPosition["result"];
  playerElo?: number;
  source?: TrainingPosition["source"];
}

/**
 * Build a {@link TrainingPosition} from a FEN and the move played, filling in
 * the legal-move list, side to move, and the full {@link PositionFeatures}
 * block. This is the Phase 1/2 glue: turn a raw (position, move) pair — from a
 * PGN, a CVS export ply, or self-play — into a labelled tuning row.
 */
export function buildTrainingPosition(
  fen: string,
  playedMove: string,
  options: BuildExampleOptions = {},
): TrainingPosition {
  const chess = new Chess(fen);
  const legalMoves = chess.moves();
  return {
    fen,
    sideToMove: chess.turn(),
    legalMoves,
    playedMove,
    bestMove: options.bestMove,
    topMoves: options.topMoves,
    evalBefore: options.evalBefore,
    evalAfterPlayed: options.evalAfterPlayed,
    evalAfterBest: options.evalAfterBest,
    cpLoss: options.cpLoss,
    classification: options.classification,
    scorePerspective: options.scorePerspective ?? "white",
    suitePurpose: options.suitePurpose,
    tablebaseClass: options.tablebaseClass,
    features: extractPositionFeatures(fen),
    result: options.result,
    playerElo: options.playerElo,
    source: options.source ?? "my_game",
  };
}

/**
 * Expand a labelled position into per-move ranking rows (Phase 2, step 2): one
 * row per legal move, labelled 1 for the best/played move and 0 otherwise.
 */
export function buildMoveRows(position: TrainingPosition): MoveTrainingRow[] {
  const label = position.bestMove ?? position.playedMove;
  const rows = featuresForAllMoves(position.fen);
  return rows.map(({ move, features }) => ({
    fen: position.fen,
    uci: move.lan,
    san: move.san,
    label: move.san === label || move.lan === label ? 1 : 0,
    features,
  }));
}
