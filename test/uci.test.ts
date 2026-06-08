import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { UciSession } from "../src/uci.js";

function legalUci(fen: string, uci: string): boolean {
  const chess = new Chess(fen);
  try {
    return !!chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
  } catch {
    return false;
  }
}

describe("UciSession (UCI protocol shim)", () => {
  it("handshakes: uci -> uciok, isready -> readyok", () => {
    const s = new UciSession();
    const hello = s.handle("uci").out;
    expect(hello).toContain("uciok");
    expect(hello).toContain("id name CVS-Policy-0");
    expect(s.handle("isready").out).toEqual(["readyok"]);
  });

  it("plays a legal bestmove from startpos + moves at fixed depth", () => {
    const s = new UciSession();
    expect(s.handle("ucinewgame").out).toEqual([]);
    expect(s.handle("position startpos moves e2e4 e7e5").out).toEqual([]);
    const out = s.handle("go depth 2").out;
    expect(out).toHaveLength(1);
    const m = out[0]!.match(/^bestmove (\S+)$/);
    expect(m).not.toBeNull();
    // Legal in the position after 1.e4 e5.
    const after = new Chess();
    after.move("e4");
    after.move("e5");
    expect(legalUci(after.fen(), m![1]!)).toBe(true);
  });

  it("accepts a position fen and a clock-budget go, returning a legal move", () => {
    const s = new UciSession();
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    s.handle(`position fen ${fen}`);
    const out = s.handle("go wtime 60000 btime 60000 winc 0 binc 0").out;
    expect(out).toHaveLength(1);
    const m = out[0]!.match(/^bestmove (\S+)$/);
    expect(m).not.toBeNull();
    expect(legalUci(fen, m![1]!)).toBe(true);
  });

  it("returns bestmove (none) at a terminal (checkmated) position", () => {
    const s = new UciSession();
    s.handle("position fen rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
    expect(s.handle("go depth 2").out).toEqual(["bestmove (none)"]);
  });

  it("signals quit", () => {
    const s = new UciSession();
    expect(s.handle("quit")).toEqual({ out: [], quit: true });
  });

  it("ignores unknown commands without crashing", () => {
    const s = new UciSession();
    expect(s.handle("setoption name Hash value 16").out).toEqual([]);
    expect(s.handle("debug on").out).toEqual([]);
    expect(s.handle("").out).toEqual([]);
  });
});
