import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { evaluate, evaluateWhite, phaseLabel } from "../src/value/valueEngine.js";
import { DEFAULT_VALUE_WEIGHTS } from "../src/value/weights.js";
import { trainValue } from "../src/value/train.js";
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
