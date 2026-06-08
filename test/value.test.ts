import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { evaluate, evaluateWhite, phaseLabel } from "../src/value/valueEngine.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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
