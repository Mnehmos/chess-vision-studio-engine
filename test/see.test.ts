import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { see, seeOnBoard } from "../src/features/see.js";
import type { Square } from "chess.js";

describe("see (static exchange evaluation)", () => {
  it("wins a free pawn that is undefended", () => {
    // White pawn e4, black pawn d5 undefended -> exd5 wins a pawn.
    const fen = "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1";
    expect(see(fen, "e4", "d5")).toBe(100);
  });

  it("is zero for an equal pawn trade on a defended square", () => {
    // Black pawn d5 defended by c6 pawn; White pawn e4 takes -> pawn for pawn.
    const fen = "4k3/8/2p5/3p4/4P3/8/8/4K3 w - - 0 1";
    expect(see(fen, "e4", "d5")).toBe(0);
  });

  it("is negative when a queen grabs a pawn defended by a pawn", () => {
    // Queen wins a pawn (100) but is recaptured by the c6 pawn (loses 900).
    const fen = "4k3/8/2p5/3p4/8/8/3Q4/4K3 w - - 0 1";
    expect(see(fen, "d2", "d5")).toBe(100 - 900);
  });

  it("returns 0 for a quiet move to a safe square", () => {
    const fen = "4k3/8/8/8/8/8/3N4/4K3 w - - 0 1";
    expect(see(fen, "d2", "f3")).toBe(0);
  });

  it("is negative for moving a piece to an undefended attacked square", () => {
    // Knight steps onto d5, which the black e6 pawn attacks; nothing defends it.
    const fen = "4k3/8/4p3/8/8/4N3/8/4K3 w - - 0 1";
    expect(see(fen, "e3", "d5")).toBe(-320);
  });

  describe("seeOnBoard (in-place) parity", () => {
    // Contract: seeOnBoard returns the SAME value as the FEN-parse path, and
    // restores PIECE PLACEMENT exactly (so a single scratch board can be reused for
    // every candidate in a node). It is used only on a throwaway scratch, so the
    // castling/ep FEN fields may drift — SEE depends only on placement, so that's
    // harmless. These positions carry castling rights + en passant to prove it.
    const CASES: { fen: string; from: Square; to: Square }[] = [
      { fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", from: "a1", to: "a7" },
      { fen: "r3k2r/p1pp1ppp/8/1B6/8/8/PPPP1PPP/R3K2R w KQkq - 0 1", from: "b5", to: "d7" },
      { fen: "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", from: "e5", to: "f6" },
      { fen: "5r2/pp5R/1kp3p1/6b1/4P1b1/1BNP2P1/PPP4P/1K6 w - - 1 22", from: "h7", to: "f8" },
      { fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", from: "f3", to: "e5" },
    ];
    const placement = (fen: string) => fen.split(" ")[0];
    for (const { fen, from, to } of CASES) {
      it(`matches see() and restores placement: ${fen.slice(0, 24)}… ${from}${to}`, () => {
        const chess = new Chess(fen);
        const onBoard = seeOnBoard(chess, from, to);
        // Reusable: piece placement is restored exactly (castling/ep may drift).
        expect(placement(chess.fen())).toBe(placement(fen));
        // Same value as the parse-based path (semantics preserved).
        expect(onBoard).toBe(see(fen, from, to));
        // Reusing the same board for a second SEE still matches (proves no drift in placement).
        expect(seeOnBoard(chess, from, to)).toBe(see(fen, from, to));
      });
    }

    it("scratch reuse over EVERY legal move matches fresh see() (the quiescence pattern)", () => {
      // The hot path reuses ONE scratch board for all SEE candidates in a node.
      // This must be byte-equivalent to calling see(fen) fresh for each move.
      const BATTERY = [
        "5r2/pp5R/1kp3p1/6b1/4P1b1/1BNP2P1/PPP4P/1K6 w - - 1 22", // the d4 forensic position
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // Kiwipete
        "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", // en passant available
        "r2q1rk1/pp2ppbp/2p2np1/6B1/3PP1b1/2N2N2/PPP2PPP/R2QK2R w KQ - 0 1",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
      ];
      for (const fen of BATTERY) {
        const scratch = new Chess(fen);
        for (const m of new Chess(fen).moves({ verbose: true })) {
          const reused = seeOnBoard(scratch, m.from as Square, m.to as Square);
          const fresh = see(fen, m.from as Square, m.to as Square);
          expect(reused, `${fen} ${m.from}${m.to}`).toBe(fresh);
        }
      }
    });
  });
});
