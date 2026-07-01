import { describe, expect, it } from "vitest";
import { Chess } from "../src/chess.js";
import { search } from "../src/search/searchEngine.js";
import { CvsEngine } from "../src/engine.js";
import { MOVE_FEATURE_KEYS, type MoveFeatures } from "../src/types.js";
import type { PolicyWeights } from "../src/policy/weights.js";

function policyWeights(overrides: Partial<Record<keyof MoveFeatures, number>>): PolicyWeights {
  return {
    bias: 0,
    weights: Object.fromEntries(
      MOVE_FEATURE_KEYS.map((key) => [key, overrides[key] ?? 0]),
    ) as PolicyWeights["weights"],
  };
}

describe("search engine", () => {
  it("finds a mate in one", () => {
    // White: Ra1; Black king boxed on g8 by its own pawns. Ra8#.
    const fen = "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1";
    const result = search(fen, { depth: 2 });
    expect(result.bestMove?.uci).toBe("a1a8");
    expect(result.mate).toBe(1);
  });

  it("wins a hanging queen", () => {
    const fen = "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";
    const result = search(fen, { depth: 3 });
    expect(result.bestMove?.uci).toBe("e4d5");
    expect(result.scoreCp).toBeGreaterThan(700);
  });

  it("returns a legal move with a principal variation from the start", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const result = search(fen, { depth: 3 });
    expect(result.bestMove).not.toBeNull();
    expect(result.pv.length).toBeGreaterThan(0);
    // The reported best move must be legal in the position.
    const chess = new Chess(fen);
    const legal = chess.moves({ verbose: true }).map((m) => m.lan);
    expect(legal).toContain(result.bestMove!.uci);
    expect(result.nodes).toBeGreaterThan(0);
  });

  it("reports root multiPV lines when requested", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const result = search(fen, { depth: 1, multiPv: 3 });
    const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.lan);

    expect(result.multiPv).toHaveLength(3);
    expect(result.multiPv.every((line) => legal.includes(line.move.uci))).toBe(true);
  });

  it("does not grab a defended pawn with the queen (quiescence)", () => {
    // Qxd5?? loses the queen to ...cxd5 (c6 pawn defends d5). Avoid it.
    const fen = "rnbqkbnr/pp2pppp/2p5/3p4/8/3Q4/PPPP1PPP/RNB1KBNR w KQkq - 0 1";
    const result = search(fen, { depth: 3 });
    expect(result.bestMove?.uci).not.toBe("d3d5");
  });

  it("uses the policy head to order root moves", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const castlePolicy = policyWeights({ isCastle: 100 });

    const classical = search(fen, {
      depth: 1,
      policyOrdering: false,
      debugRootMoveOrder: true,
    });
    const policyOrdered = search(fen, {
      depth: 1,
      policyWeights: castlePolicy,
      debugRootMoveOrder: true,
    });

    expect(["e1g1", "e1c1"]).not.toContain(classical.rootMoveOrder?.[0]);
    expect(["e1g1", "e1c1"]).toContain(policyOrdered.rootMoveOrder?.[0]);
  });

  it("passes CvsEngine policy weights into search ordering", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const engine = new CvsEngine({ weights: policyWeights({ isCastle: 100 }) });

    const result = engine.analyze(fen, { depth: 1, debugRootMoveOrder: true });

    expect(["e1g1", "e1c1"]).toContain(result.rootMoveOrder?.[0]);
  });
});
