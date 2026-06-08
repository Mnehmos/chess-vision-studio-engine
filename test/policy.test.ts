import { describe, expect, it } from "vitest";
import { rankMoves, topCandidates } from "../src/policy/policyEngine.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Black's queen sits undefended on d5, attacked by the white e4 pawn.
const HANGING_QUEEN_FEN = "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

describe("policy engine", () => {
  it("produces a probability distribution that sums to 1", () => {
    const ranked = rankMoves(START_FEN);
    expect(ranked.length).toBe(20);
    const total = ranked.reduce((acc, m) => acc + m.prob, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("returns candidates sorted by descending score", () => {
    const ranked = rankMoves(START_FEN);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it("ranks a free winning capture (pawn takes queen) at the very top", () => {
    const top = topCandidates(HANGING_QUEEN_FEN, 1)[0]!;
    expect(top.uci).toBe("e4d5");
    expect(top.features.see).toBeGreaterThan(800);
  });

  it("scores the winning capture above a quiet wing pawn push", () => {
    const ranked = rankMoves(HANGING_QUEEN_FEN);
    const capture = ranked.find((m) => m.uci === "e4d5")!;
    const quiet = ranked.find((m) => m.uci === "a2a3")!;
    expect(capture.score).toBeGreaterThan(quiet.score);
  });
});
