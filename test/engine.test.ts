import { describe, expect, it } from "vitest";
import { Chess } from "../src/chess.js";
import { CvsEngine } from "../src/engine.js";
import { rustCoreBinaryPath } from "../src/rust/core.js";
import { evaluateWhite } from "../src/value/valueEngine.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("CvsEngine", () => {
  const engine = new CvsEngine();

  it("predicts up to k policy candidates", () => {
    const top3 = engine.predict(START_FEN, 3);
    expect(top3.length).toBe(3);
    expect(top3[0]!.prob).toBeGreaterThanOrEqual(top3[1]!.prob);
  });

  it("exposes the static value evaluation consistent with the value engine", () => {
    expect(engine.evaluate(START_FEN)).toBe(evaluateWhite(new Chess(START_FEN)));
  });

  it("analyze() returns a coherent search + policy bundle", () => {
    const result = engine.analyze(START_FEN, { depth: 2, candidates: 4 });
    expect(result.fen).toBe(START_FEN);
    expect(result.bestMove).not.toBeNull();
    expect(result.policy.length).toBe(4);
    expect(result.depth).toBe(2);
    expect(result.nodes).toBeGreaterThan(0);
  });

  it("returns null best move for a terminal (checkmate) position", () => {
    // Fool's mate position, Black has been mated.
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    expect(engine.bestMove(mated, { depth: 2 })).toBeNull();
  });

  it("can use the Rust search core when the release binary is built", () => {
    if (!rustCoreBinaryPath()) return;
    const result = new CvsEngine({ searchCore: "rust" }).analyze(START_FEN, {
      depth: 2,
      candidates: 2,
      multiPv: 3,
    });

    expect(result.bestMove).not.toBeNull();
    expect(result.depth).toBe(2);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.pv.length).toBeGreaterThan(0);
    expect(result.multiPv).toHaveLength(3);
    expect(result.policy).toHaveLength(2);
  });
});
