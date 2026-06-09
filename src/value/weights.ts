// Trainable value-head weights — a LOW-parameter (9-scalar) overlay on the
// hand-crafted evaluation so the value function can be tuned from Stockfish-
// labeled positions without a rewrite. At DEFAULT_VALUE_WEIGHTS the weighted
// eval is bit-identical to the original constants (material 100/320/330/500/900,
// PST scale 1, bishop-pair 30, tempo 10), so default play is unchanged.
import type { PieceSymbol } from "chess.js";

export type MaterialPiece = Exclude<PieceSymbol, "k">; // king material is fixed

export interface ValueWeights {
  /** Multipliers on PIECE_VALUE per piece type (default 1 reproduces 100/320/330/500/900). */
  material: Record<MaterialPiece, number>;
  /** Global multiplier on the tapered positional (PST) term. */
  pstScale: number;
  /** Bishop-pair bonus, centipawns (default 30). */
  bishopPair: number;
  /** Tempo bonus for the side to move, centipawns (default 10). */
  tempo: number;
}

export const DEFAULT_VALUE_WEIGHTS: ValueWeights = {
  material: { p: 1, n: 1, b: 1, r: 1, q: 1 },
  pstScale: 1,
  bishopPair: 30,
  tempo: 10,
};

/** Canonical flat order for the trainable scalars (matches flatten/unflatten). */
export const VALUE_WEIGHT_KEYS = ["p", "n", "b", "r", "q", "pstScale", "bishopPair", "tempo"] as const;

export function flattenValueWeights(w: ValueWeights): number[] {
  return [w.material.p, w.material.n, w.material.b, w.material.r, w.material.q, w.pstScale, w.bishopPair, w.tempo];
}

export function unflattenValueWeights(v: number[]): ValueWeights {
  return {
    material: { p: v[0] ?? 1, n: v[1] ?? 1, b: v[2] ?? 1, r: v[3] ?? 1, q: v[4] ?? 1 },
    pstScale: v[5] ?? 1,
    bishopPair: v[6] ?? 30,
    tempo: v[7] ?? 10,
  };
}
