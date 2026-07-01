import { describe, expect, it } from "vitest";
import { Chess } from "../src/chess.js";

describe("native Chess backend", () => {
  it("generates the normal starting move count", () => {
    const chess = new Chess();
    expect(chess.moves()).toHaveLength(20);
    expect(chess.fen()).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });

  it("handles castling rights and rook movement", () => {
    const chess = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");

    expect(chess.moves()).toContain("O-O");
    expect(chess.moves()).toContain("O-O-O");
    const move = chess.move({ from: "e1", to: "g1" });

    expect(move?.san).toBe("O-O");
    expect(chess.fen()).toBe("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
  });

  it("handles en-passant captures", () => {
    const chess = new Chess("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");

    expect(chess.moves()).toContain("exd6");
    const move = chess.move({ from: "e5", to: "d6" });

    expect(move?.flags).toContain("e");
    expect(chess.fen()).toBe("4k3/8/3P4/8/8/8/8/4K3 b - - 0 2");
  });

  it("handles promotion notation and board state", () => {
    const chess = new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");

    const move = chess.move({ from: "a7", to: "a8", promotion: "q" });

    expect(move?.san).toBe("a8=Q+");
    expect(chess.get("a8")?.type).toBe("q");
    expect(chess.fen()).toBe("Q3k3/8/8/8/8/8/8/4K3 b - - 0 1");
  });

  it("filters moves that expose the king", () => {
    const chess = new Chess("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    const legalUci = chess.moves({ verbose: true }).map((move) => move.lan);

    expect(legalUci).not.toContain("e2d2");
  });

  it("round-trips make/undo over a deterministic legal move sequence", () => {
    const chess = new Chess();
    const fens = [chess.fen()];
    let seed = 0x5eed;

    for (let ply = 0; ply < 48 && !chess.isGameOver(); ply++) {
      const moves = chess.moves({ verbose: true });
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const move = moves[seed % moves.length]!;
      expect(chess.move({ from: move.from, to: move.to, promotion: move.promotion })).not.toBeNull();
      fens.push(chess.fen());
    }

    for (let i = fens.length - 1; i > 0; i--) {
      expect(chess.fen()).toBe(fens[i]);
      expect(chess.undo()).not.toBeNull();
    }

    expect(chess.fen()).toBe(fens[0]);
    expect(chess.undo()).toBeNull();
  });

  it("normalizes FEN counters, castling rights, and en-passant visibility", () => {
    const quiet = new Chess();
    quiet.move({ from: "g1", to: "f3" });
    quiet.move({ from: "g8", to: "f6" });
    expect(quiet.fen()).toBe("rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2");

    const castling = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    castling.move({ from: "h1", to: "h2" });
    expect(castling.fen()).toBe("r3k2r/8/8/8/8/8/7R/R3K3 b Qkq - 1 1");

    const hiddenEp = new Chess();
    hiddenEp.move({ from: "e2", to: "e4" });
    expect(hiddenEp.fen()).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");

    const visibleEp = new Chess("7k/8/8/8/3p4/8/4P3/4K3 w - - 0 1");
    visibleEp.move({ from: "e2", to: "e4" });
    expect(visibleEp.fen()).toBe("7k/8/8/8/3pP3/8/8/4K3 b - e3 0 1");
  });

  it("handles mate, stalemate, and insufficient-material edge cases", () => {
    expect(new Chess("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3").isCheckmate()).toBe(true);
    expect(new Chess("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1").isStalemate()).toBe(true);
    expect(new Chess("8/8/8/8/8/8/6B1/4K1k1 w - - 0 1").isInsufficientMaterial()).toBe(true);
    expect(new Chess("8/8/8/8/8/8/5NN1/4K1k1 w - - 0 1").isInsufficientMaterial()).toBe(true);
  });
});
