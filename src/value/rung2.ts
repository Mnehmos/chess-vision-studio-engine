// Rung-2 value features (INERT infrastructure). A coherent feature pack modelling
// the positional structure the 9-scalar Rung-1 eval cannot see: mobility, king
// safety, passed pawns, rook activity, pawn structure. Every feature is a
// White-POV SIGNED scalar (positive = good for White), so a term is just
// weight·feature and the negamax/POV handling is identical to the existing terms.
//
// CRITICAL INVARIANT: DEFAULT_RUNG2_WEIGHTS are all 0, so the Rung-2 contribution
// is 0 and evaluateWhiteFloat is byte-identical until a weight is explicitly set.
// This is capacity behind a gate — extraction + partials only. The live engine
// and search do NOT pass Rung-2 weights yet; nothing here changes default play.
//
// Phase taper: mg/eg-tapered features (passed pawns, bishop pair) are split into
// two weights so the trainer can learn opening vs endgame importance.
//
// NOTE: several terms (backward-pawn omitted, king zone, hanging) are standard but
// approximate; validate per-FEN via `rung2:dump` before training them live.
import { Chess } from "chess.js";
import type { Color, PieceSymbol } from "chess.js";
import { MAX_PHASE, PHASE_VALUE, PIECE_VALUE } from "../constants.js";

export const RUNG2_KEYS = [
  "mobilityKnight",
  "mobilityBishop",
  "mobilityRook",
  "mobilityQueen",
  "kingShield",
  "kingZonePressure",
  "kingOpenFile",
  "passedPawnMg",
  "passedPawnEg",
  "connectedPassedPawn",
  "rookOpenFile",
  "rookSemiOpenFile",
  "rookSeventh",
  "doubledPawn",
  "isolatedPawn",
  "bishopPairMg",
  "bishopPairEg",
  "hangingPiece",
] as const;

export type Rung2Key = (typeof RUNG2_KEYS)[number];
export type Rung2Features = Record<Rung2Key, number>;
export type Rung2Weights = Record<Rung2Key, number>;

export const DEFAULT_RUNG2_WEIGHTS: Rung2Weights = Object.fromEntries(
  RUNG2_KEYS.map((k) => [k, 0]),
) as Rung2Weights;

// ---- board grid helpers (r = 0 is rank 8 .. r = 7 is rank 1; f = 0 is file a) ----

type Cell = { type: PieceSymbol; color: Color } | null;
type Grid = Cell[][];

function toGrid(chess: Chess): Grid {
  return chess.board().map((row) => row.map((p) => (p ? { type: p.type, color: p.color } : null)));
}

function inb(r: number, f: number): boolean {
  return r >= 0 && r < 8 && f >= 0 && f < 8;
}

const KNIGHT_OFFSETS = [
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [1, -2],
  [-1, 2],
  [-1, -2],
];
const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const KING_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Pseudo-legal mobility (empty squares + captures, ignoring pins/checks). */
function slideMobility(g: Grid, r: number, f: number, color: Color, dirs: number[][]): number {
  let c = 0;
  for (const [dr, df] of dirs) {
    let rr = r + dr!;
    let ff = f + df!;
    while (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (!occ) {
        c++;
      } else {
        if (occ.color !== color) c++;
        break;
      }
      rr += dr!;
      ff += df!;
    }
  }
  return c;
}

function knightMobility(g: Grid, r: number, f: number, color: Color): number {
  let c = 0;
  for (const [dr, df] of KNIGHT_OFFSETS) {
    const rr = r + dr!;
    const ff = f + df!;
    if (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (!occ || occ.color !== color) c++;
    }
  }
  return c;
}

/** Is square (r,f) attacked by any piece of `by`? */
function isAttackedBy(g: Grid, r: number, f: number, by: Color): boolean {
  // Pawns: a `by` pawn attacks diagonally toward the enemy. White pawns move up
  // (decreasing r), so a white pawn attacking (r,f) sits at (r+1, f±1).
  const pawnRow = by === "w" ? r + 1 : r - 1;
  for (const df of [-1, 1]) {
    const ff = f + df;
    if (inb(pawnRow, ff)) {
      const occ = g[pawnRow]![ff]!;
      if (occ && occ.color === by && occ.type === "p") return true;
    }
  }
  // Knights.
  for (const [dr, df] of KNIGHT_OFFSETS) {
    const rr = r + dr!;
    const ff = f + df!;
    if (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (occ && occ.color === by && occ.type === "n") return true;
    }
  }
  // King.
  for (const [dr, df] of KING_OFFSETS) {
    const rr = r + dr!;
    const ff = f + df!;
    if (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (occ && occ.color === by && occ.type === "k") return true;
    }
  }
  // Sliding: bishop/queen on diagonals, rook/queen on orthogonals.
  for (const [dr, df] of BISHOP_DIRS) {
    let rr = r + dr!;
    let ff = f + df!;
    while (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (occ) {
        if (occ.color === by && (occ.type === "b" || occ.type === "q")) return true;
        break;
      }
      rr += dr!;
      ff += df!;
    }
  }
  for (const [dr, df] of ROOK_DIRS) {
    let rr = r + dr!;
    let ff = f + df!;
    while (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (occ) {
        if (occ.color === by && (occ.type === "r" || occ.type === "q")) return true;
        break;
      }
      rr += dr!;
      ff += df!;
    }
  }
  return false;
}

// ---- pawn-structure scratch ----

interface PawnInfo {
  /** pawnsByFile[color][file] = list of ranks-from-own-side (1..8) on that file. */
  whiteByFile: number[][];
  blackByFile: number[][];
  whiteRows: { r: number; f: number }[];
  blackRows: { r: number; f: number }[];
}

function scanPawns(g: Grid): PawnInfo {
  const whiteByFile: number[][] = Array.from({ length: 8 }, () => []);
  const blackByFile: number[][] = Array.from({ length: 8 }, () => []);
  const whiteRows: { r: number; f: number }[] = [];
  const blackRows: { r: number; f: number }[] = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const occ = g[r]![f]!;
      if (!occ || occ.type !== "p") continue;
      if (occ.color === "w") {
        whiteByFile[f]!.push(8 - r); // rank 1..8 from White's side
        whiteRows.push({ r, f });
      } else {
        blackByFile[f]!.push(r + 1); // rank from Black's side (row 7 = rank 1 for black)
        blackRows.push({ r, f });
      }
    }
  }
  return { whiteByFile, blackByFile, whiteRows, blackRows };
}

/** White pawn at (r,f) is passed if no black pawn lies ahead on f-1..f+1. */
function isPassed(g: Grid, r: number, f: number, color: Color): boolean {
  const enemy: Color = color === "w" ? "b" : "w";
  const dir = color === "w" ? -1 : 1; // ahead = toward enemy back rank
  for (let ff = f - 1; ff <= f + 1; ff++) {
    if (ff < 0 || ff > 7) continue;
    let rr = r + dir;
    while (inb(rr, ff)) {
      const occ = g[rr]![ff]!;
      if (occ && occ.type === "p" && occ.color === enemy) return false;
      rr += dir;
    }
  }
  return true;
}

// ---- main extraction ----

/** Extract the Rung-2 features (White-POV signed scalars) for a position. */
export function extractRung2Features(chess: Chess): Rung2Features {
  const g = toGrid(chess);
  let units = 0;
  for (const row of g) for (const cell of row) if (cell) units += PHASE_VALUE[cell.type];
  units = Math.min(units, MAX_PHASE);
  const mgWeight = units / MAX_PHASE;
  const egWeight = 1 - mgWeight;

  const f: Rung2Features = Object.fromEntries(RUNG2_KEYS.map((k) => [k, 0])) as Rung2Features;

  // Locate kings.
  let wk: { r: number; f: number } | null = null;
  let bk: { r: number; f: number } | null = null;

  let whiteBishops = 0;
  let blackBishops = 0;

  // Mobility + bishop counts + king locations.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const occ = g[r]![c]!;
      if (!occ) continue;
      const sign = occ.color === "w" ? 1 : -1;
      switch (occ.type) {
        case "n":
          f.mobilityKnight += sign * knightMobility(g, r, c, occ.color);
          break;
        case "b":
          f.mobilityBishop += sign * slideMobility(g, r, c, occ.color, BISHOP_DIRS);
          if (occ.color === "w") whiteBishops++;
          else blackBishops++;
          break;
        case "r":
          f.mobilityRook += sign * slideMobility(g, r, c, occ.color, ROOK_DIRS);
          break;
        case "q":
          f.mobilityQueen += sign * slideMobility(g, r, c, occ.color, [...BISHOP_DIRS, ...ROOK_DIRS]);
          break;
        case "k":
          if (occ.color === "w") wk = { r, f: c };
          else bk = { r, f: c };
          break;
        default:
          break;
      }
    }
  }

  // Bishop pair (tapered) — additive refinement of the flat Rung-1 bishopPair.
  const pairInd = (whiteBishops >= 2 ? 1 : 0) - (blackBishops >= 2 ? 1 : 0);
  f.bishopPairMg = pairInd * mgWeight;
  f.bishopPairEg = pairInd * egWeight;

  // Pawn structure.
  const pawns = scanPawns(g);
  let passedSigned = 0; // white passer advancement − black
  let connectedSigned = 0;
  let doubledSigned = 0; // black doubled − white (positive = good for White)
  let isolatedSigned = 0;

  for (let file = 0; file < 8; file++) {
    const w = pawns.whiteByFile[file]!;
    const b = pawns.blackByFile[file]!;
    if (w.length > 1) doubledSigned -= w.length - 1;
    if (b.length > 1) doubledSigned += b.length - 1;
    const wAdj = (pawns.whiteByFile[file - 1]?.length ?? 0) + (pawns.whiteByFile[file + 1]?.length ?? 0);
    const bAdj = (pawns.blackByFile[file - 1]?.length ?? 0) + (pawns.blackByFile[file + 1]?.length ?? 0);
    if (w.length > 0 && wAdj === 0) isolatedSigned -= w.length; // white isolated is bad for White
    if (b.length > 0 && bAdj === 0) isolatedSigned += b.length;
  }

  for (const { r, f: file } of pawns.whiteRows) {
    if (isPassed(g, r, file, "w")) {
      passedSigned += 8 - r - 1; // advancement (rank 2 → 0 .. rank 7 → 5)
      const adj = (pawns.whiteByFile[file - 1]?.length ?? 0) + (pawns.whiteByFile[file + 1]?.length ?? 0);
      if (adj > 0) connectedSigned += 1;
    }
  }
  for (const { r, f: file } of pawns.blackRows) {
    if (isPassed(g, r, file, "b")) {
      passedSigned -= r - 1; // black advancement (rank 2 from black = row 6 → 5)
      const adj = (pawns.blackByFile[file - 1]?.length ?? 0) + (pawns.blackByFile[file + 1]?.length ?? 0);
      if (adj > 0) connectedSigned -= 1;
    }
  }
  f.passedPawnMg = passedSigned * mgWeight;
  f.passedPawnEg = passedSigned * egWeight;
  f.connectedPassedPawn = connectedSigned;
  f.doubledPawn = doubledSigned;
  f.isolatedPawn = isolatedSigned;

  // Rook activity: open / semi-open files and the 7th rank.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const occ = g[r]![c]!;
      if (!occ || occ.type !== "r") continue;
      const sign = occ.color === "w" ? 1 : -1;
      const whitePawnsOnFile = pawns.whiteByFile[c]!.length;
      const blackPawnsOnFile = pawns.blackByFile[c]!.length;
      const noPawns = whitePawnsOnFile === 0 && blackPawnsOnFile === 0;
      const ownPawns = occ.color === "w" ? whitePawnsOnFile : blackPawnsOnFile;
      const enemyPawns = occ.color === "w" ? blackPawnsOnFile : whitePawnsOnFile;
      if (noPawns) f.rookOpenFile += sign;
      else if (ownPawns === 0 && enemyPawns > 0) f.rookSemiOpenFile += sign;
      // 7th rank from the rook's own side: White rook on row 1 (rank 7), Black on row 6 (rank 2).
      if ((occ.color === "w" && r === 1) || (occ.color === "b" && r === 6)) f.rookSeventh += sign;
    }
  }

  // King safety: shield pawns, zone pressure, open files near the king.
  if (wk && bk) {
    f.kingShield = shieldPawns(g, wk, "w") - shieldPawns(g, bk, "b");
    const blackZoneAttacked = kingZoneAttacked(g, bk, "w");
    const whiteZoneAttacked = kingZoneAttacked(g, wk, "b");
    f.kingZonePressure = blackZoneAttacked - whiteZoneAttacked; // positive = Black king more pressured
    const whiteExposure = kingFileExposure(pawns, wk.f, "w");
    const blackExposure = kingFileExposure(pawns, bk.f, "b");
    f.kingOpenFile = blackExposure - whiteExposure; // positive = Black king more exposed
  }

  // Hanging material: attacked-and-undefended non-king pieces.
  let whiteHanging = 0;
  let blackHanging = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const occ = g[r]![c]!;
      if (!occ || occ.type === "k") continue;
      const enemy: Color = occ.color === "w" ? "b" : "w";
      if (isAttackedBy(g, r, c, enemy) && !isAttackedBy(g, r, c, occ.color)) {
        if (occ.color === "w") whiteHanging += PIECE_VALUE[occ.type];
        else blackHanging += PIECE_VALUE[occ.type];
      }
    }
  }
  f.hangingPiece = (blackHanging - whiteHanging) / 100; // pawns; positive = Black hangs more

  return f;
}

/** Friendly pawns on the king's file ±1, one/two ranks ahead of the king. */
function shieldPawns(g: Grid, king: { r: number; f: number }, color: Color): number {
  const dir = color === "w" ? -1 : 1; // ahead
  let count = 0;
  for (let df = -1; df <= 1; df++) {
    const ff = king.f + df;
    if (ff < 0 || ff > 7) continue;
    for (let step = 1; step <= 2; step++) {
      const rr = king.r + dir * step;
      if (!inb(rr, ff)) continue;
      const occ = g[rr]![ff]!;
      if (occ && occ.type === "p" && occ.color === color) count++;
    }
  }
  return count;
}

/** Number of squares in the king's zone (king + 8 neighbours) attacked by `by`. */
function kingZoneAttacked(g: Grid, king: { r: number; f: number }, by: Color): number {
  let count = 0;
  for (const [dr, df] of [[0, 0], ...KING_OFFSETS]) {
    const rr = king.r + dr!;
    const ff = king.f + df!;
    if (inb(rr, ff) && isAttackedBy(g, rr, ff, by)) count++;
  }
  return count;
}

/** Files on the king's file ±1 that have no friendly pawn (exposure). */
function kingFileExposure(pawns: PawnInfo, kf: number, color: Color): number {
  const byFile = color === "w" ? pawns.whiteByFile : pawns.blackByFile;
  let exposure = 0;
  for (let df = -1; df <= 1; df++) {
    const ff = kf + df;
    if (ff < 0 || ff > 7) continue;
    if ((byFile[ff]?.length ?? 0) === 0) exposure++;
  }
  return exposure;
}

// ---- weights ↔ contribution ----

export function flattenRung2(w: Rung2Weights): number[] {
  return RUNG2_KEYS.map((k) => w[k]);
}

export function flattenRung2Features(f: Rung2Features): number[] {
  return RUNG2_KEYS.map((k) => f[k]);
}

export function unflattenRung2Weights(v: number[]): Rung2Weights {
  return Object.fromEntries(RUNG2_KEYS.map((k, i) => [k, v[i] ?? 0])) as Rung2Weights;
}

/**
 * White-POV centipawn contribution of the Rung-2 terms: Σ weight·feature. The
 * partial derivative w.r.t. each weight IS the corresponding feature value, so a
 * future Rung-2 trainer reuses extractRung2Features directly as its coefficients.
 * Returns 0 for DEFAULT_RUNG2_WEIGHTS (all zero) → byte-identical eval.
 */
export function rung2Contribution(chess: Chess, weights: Rung2Weights = DEFAULT_RUNG2_WEIGHTS): number {
  let active = false;
  for (const k of RUNG2_KEYS) {
    if (weights[k] !== 0) {
      active = true;
      break;
    }
  }
  if (!active) return 0; // fast path: no extraction when all weights are zero
  const f = extractRung2Features(chess);
  let s = 0;
  for (const k of RUNG2_KEYS) s += weights[k] * f[k];
  return s;
}
