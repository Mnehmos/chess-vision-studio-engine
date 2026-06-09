import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { evaluate, evaluateWhite, evaluateWhiteFloat, phaseLabel } from "../src/value/valueEngine.js";
import { DEFAULT_VALUE_WEIGHTS } from "../src/value/weights.js";
import { trainValue } from "../src/value/train.js";
import { preferenceScore, trainValueRanking } from "../src/value/trainRanking.js";
import { extractRung2Features, DEFAULT_RUNG2_WEIGHTS, RUNG2_KEYS } from "../src/value/rung2.js";
import { CvsEngine } from "../src/engine.js";
import type { TrainingPosition } from "../src/types.js";
import { buildTrainingPosition } from "../src/benchmark/dataset.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FEN_BATTERY = [
  START_FEN,
  "4k3/8/8/8/8/8/8/3QK3 w - - 0 1",
  "r3k3/8/8/8/8/8/8/4K3 b - - 0 1",
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  "8/2k5/8/8/3K4/8/5R2/8 w - - 0 1",
  "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2",
];

describe("value engine", () => {
  it("evaluates the start position near equality", () => {
    // Only the tempo term should remain; PSTs and material are symmetric.
    expect(Math.abs(evaluateWhite(new Chess(START_FEN)))).toBeLessThanOrEqual(20);
  });

  it("rewards White for being up a queen", () => {
    // White has an extra queen.
    const fen = "4k3/8/8/8/8/8/8/3QK3 w - - 0 1";
    expect(evaluateWhite(new Chess(fen))).toBeGreaterThan(800);
  });

  it("rewards Black for being up a rook (negative for White)", () => {
    const fen = "r3k3/8/8/8/8/8/8/4K3 b - - 0 1";
    expect(evaluateWhite(new Chess(fen))).toBeLessThan(-400);
  });

  it("returns side-to-move-relative scores from evaluate()", () => {
    const fen = "r3k3/8/8/8/8/8/8/4K3 b - - 0 1";
    // Black is up a rook and it is Black to move -> positive from their view.
    expect(evaluate(new Chess(fen))).toBeGreaterThan(400);
  });

  it("labels phases by remaining material", () => {
    expect(phaseLabel(new Chess(START_FEN))).toBe("opening");
    expect(phaseLabel(new Chess("4k3/8/8/8/8/8/8/4K3 w - - 0 1"))).toBe("endgame");
  });
});

describe("trainable value head", () => {
  it("reduces to current behavior at DEFAULT_VALUE_WEIGHTS", () => {
    // Passing the defaults explicitly must be bit-identical to the no-arg path
    // (which is itself the handcrafted constants), for both POVs.
    for (const fen of FEN_BATTERY) {
      const c = new Chess(fen);
      expect(evaluateWhite(c, DEFAULT_VALUE_WEIGHTS)).toBe(evaluateWhite(c));
      expect(evaluate(c, DEFAULT_VALUE_WEIGHTS)).toBe(evaluate(c));
    }
  });

  it("search is unchanged when default value weights are injected", () => {
    // CvsEngine with explicit default value weights builds an injected Searcher;
    // it must pick the same searched move as the default Searcher path.
    const base = new CvsEngine();
    const injected = new CvsEngine({ valueWeights: DEFAULT_VALUE_WEIGHTS });
    for (const fen of FEN_BATTERY.slice(0, 4)) {
      const a = base.bestMove(fen, { depth: 3 });
      const b = injected.bestMove(fen, { depth: 3 });
      expect(b?.uci).toBe(a?.uci);
    }
  });

  it("trainValue lowers loss and stays near the seed on consistent labels", () => {
    // Label each position with its own handcrafted White-POV eval -> the optimum
    // IS the seed, so training should not run away from the defaults.
    const positions: TrainingPosition[] = FEN_BATTERY.map((fen) => {
      const evalBefore = evaluateWhite(new Chess(fen));
      const legal = new Chess(fen).moves();
      const best = legal[0] ?? "--";
      return buildTrainingPosition(fen, best, { bestMove: best, evalBefore, cpLoss: 0, source: "master_game" });
    });
    const res = trainValue(positions, { epochs: 80, learningRate: 0.05 });
    expect(res.examples).toBe(FEN_BATTERY.length);
    expect(res.history.at(-1)!.loss).toBeLessThanOrEqual(res.history[0]!.loss + 1e-9);
    // Material multipliers should remain close to 1 (strong prior, consistent labels).
    for (const t of ["p", "n", "b", "r", "q"] as const) {
      expect(Math.abs(res.weights.material[t] - 1)).toBeLessThan(0.5);
    }
  });
});

describe("sibling-ranking value head (Phase B)", () => {
  it("preferenceScore equals the negamax leaf −value(child) for both POVs (the sign landmine)", () => {
    // parent preference for a move MUST equal −evaluate(child); a flipped sign
    // would teach the engine to prefer the most dangerous child while looking
    // numerically stable. Test in float (exact), across white- and black-to-move.
    for (const fen of FEN_BATTERY) {
      const parent = new Chess(fen);
      for (const san of parent.moves().slice(0, 6)) {
        const child = new Chess(fen);
        child.move(san);
        const childStm = child.turn() === "w" ? 1 : -1;
        const evalFloatStm = childStm * evaluateWhiteFloat(child, DEFAULT_VALUE_WEIGHTS);
        expect(preferenceScore(parent.turn(), child, DEFAULT_VALUE_WEIGHTS)).toBe(-evalFloatStm);
      }
    }
  });

  it("trainValueRanking runs, lowers hinge loss, returns finite weights", () => {
    const positions: TrainingPosition[] = [];
    for (const fen of FEN_BATTERY) {
      const c = new Chess(fen);
      const moves = c.moves().slice(0, 5);
      if (moves.length < 2) continue;
      // Synthetic best-first cp ladder: first move best (cpLoss 0), rest worse.
      const topMoves = moves.map((san, i) => {
        const ch = new Chess(fen);
        const mv = ch.move(san);
        return { san, uci: mv?.lan ?? "", cp: 50 - i * 60, mate: undefined, depth: 10 };
      });
      positions.push(buildTrainingPosition(fen, moves[0]!, { bestMove: moves[0]!, topMoves, source: "master_game" }));
    }
    const res = trainValueRanking(positions, { epochs: 60, learningRate: 0.01 });
    expect(res.examples).toBeGreaterThan(0);
    expect(res.pairs).toBeGreaterThan(0);
    expect(res.history.length).toBe(60);
    expect(res.history.at(-1)!.loss).toBeLessThanOrEqual(res.history[0]!.loss + 1e-9);
    for (const t of ["p", "n", "b", "r", "q"] as const) {
      expect(Number.isFinite(res.weights.material[t])).toBe(true);
    }
    expect(res.history.at(-1)!.rankAccuracy).toBeGreaterThanOrEqual(0);
    expect(res.history.at(-1)!.rankAccuracy).toBeLessThanOrEqual(1);
  });
});

describe("Rung-2 value features (inert capacity)", () => {
  it("eval is byte-identical with default (all-zero) or omitted Rung-2 weights", () => {
    // THE invariant: Rung-2 is dormant until a weight is explicitly set.
    for (const fen of FEN_BATTERY) {
      const c = new Chess(fen);
      expect(evaluateWhite(c, DEFAULT_VALUE_WEIGHTS, DEFAULT_RUNG2_WEIGHTS)).toBe(evaluateWhite(c, DEFAULT_VALUE_WEIGHTS));
      expect(evaluateWhiteFloat(c, DEFAULT_VALUE_WEIGHTS, DEFAULT_RUNG2_WEIGHTS)).toBe(
        evaluateWhiteFloat(c, DEFAULT_VALUE_WEIGHTS),
      );
    }
  });

  it("the start position is feature-symmetric (every Rung-2 feature ≈ 0)", () => {
    const feats = extractRung2Features(new Chess(START_FEN));
    for (const k of RUNG2_KEYS) expect(Math.abs(feats[k])).toBeLessThan(1e-9);
  });

  it("extracts a positive White-POV signal for a rook on an open file", () => {
    // White rook a1 on an empty board: every file open, no black rook.
    const fen = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
    const feats = extractRung2Features(new Chess(fen));
    expect(feats.rookOpenFile).toBeGreaterThan(0);
    expect(feats.mobilityRook).toBeGreaterThan(0);
  });

  it("a non-zero Rung-2 weight changes the eval (capacity is reachable)", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
    const c = new Chess(fen);
    const base = evaluateWhite(c, DEFAULT_VALUE_WEIGHTS);
    const withTerm = evaluateWhite(c, DEFAULT_VALUE_WEIGHTS, { ...DEFAULT_RUNG2_WEIGHTS, rookOpenFile: 50 });
    expect(withTerm).not.toBe(base);
    expect(withTerm).toBeGreaterThan(base); // open-file bonus helps White
  });
});
