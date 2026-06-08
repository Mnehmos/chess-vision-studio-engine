import { describe, expect, it } from "vitest";
import { see } from "../src/features/see.js";

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
});
