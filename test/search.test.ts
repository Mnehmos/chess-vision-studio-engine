import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { search } from "../src/search/searchEngine.js";

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

  it("does not grab a defended pawn with the queen (quiescence)", () => {
    // Qxd5?? loses the queen to ...cxd5 (c6 pawn defends d5). Avoid it.
    const fen = "rnbqkbnr/pp2pppp/2p5/3p4/8/3Q4/PPPP1PPP/RNB1KBNR w KQkq - 0 1";
    const result = search(fen, { depth: 3 });
    expect(result.bestMove?.uci).not.toBe("d3d5");
  });
});
