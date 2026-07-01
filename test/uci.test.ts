import { describe, expect, it } from "vitest";
import { UciSession } from "../src/uci.js";

describe("UciSession", () => {
  it("performs the UCI handshake", () => {
    const session = new UciSession({ name: "Test Engine", author: "Test Author" });

    expect(session.processLine("uci")).toEqual([
      "id name Test Engine",
      "id author Test Author",
      "option name Default Depth type spin default 4 min 1 max 64",
      "option name Move Overhead type spin default 50 min 0 max 5000",
      "option name MultiPV type spin default 1 min 1 max 32",
      "option name Policy Ordering type check default true",
      "option name Policy Ordering Weight type spin default 1000 min 0 max 100000",
      "uciok",
    ]);
  });

  it("responds to readiness checks", () => {
    const session = new UciSession();
    expect(session.processLine("isready")).toEqual(["readyok"]);
  });

  it("parses startpos plus UCI moves", () => {
    const session = new UciSession();

    expect(session.processLine("position startpos moves e2e4 e7e5")).toEqual([]);
    expect(session.fen()).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  });

  it("allows supported options to be changed", () => {
    const session = new UciSession();

    expect(session.processLine("setoption name Default Depth value 2")).toEqual([]);
    expect(session.processLine("setoption name Policy Ordering value false")).toEqual([]);
    expect(session.processLine("uci")).toContain("option name Default Depth type spin default 2 min 1 max 64");
    expect(session.processLine("uci")).toContain("option name Policy Ordering type check default false");
  });

  it("searches and reports bestmove in UCI format", () => {
    const session = new UciSession();
    session.processLine("position fen 6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1");

    const output = session.processLine("go depth 2");

    expect(output[0]).toMatch(/^info depth \d+ seldepth \d+ time \d+ nodes \d+ nps \d+ hashfull \d+ multipv 1 score mate 1 pv a1a8/);
    expect(output.at(-1)).toBe("bestmove a1a8");
  });

  it("handles common GUI go transcript options", () => {
    const session = new UciSession();
    expect(session.processLine("position startpos")).toEqual([]);

    const searchMoves = session.processLine("go depth 1 searchmoves e2e4");
    expect(searchMoves.at(-1)).toBe("bestmove e2e4");

    const nodes = session.processLine("go depth 3 nodes 100");
    expect(nodes.at(-1)).toMatch(/^bestmove (0000|[a-h][1-8][a-h][1-8][qrbn]?)$/);

    const movetime = session.processLine("go movetime 20");
    expect(movetime[0]).toContain(" time ");
    expect(movetime.at(-1)).toMatch(/^bestmove /);
  });

  it("supports mate searches and ponder result flushing", () => {
    const session = new UciSession();
    session.processLine("position fen 6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1");

    expect(session.processLine("go mate 1").at(-1)).toBe("bestmove a1a8");

    const ponder = session.processLine("go ponder depth 1");
    expect(ponder.some((line) => line.startsWith("bestmove"))).toBe(false);
    expect(session.processLine("ponderhit").at(-1)).toBe("bestmove a1a8");
    expect(session.processLine("stop")).toEqual([]);
  });

  it("marks the session as done on quit", () => {
    const session = new UciSession();
    expect(session.processLine("quit")).toEqual([]);
    expect(session.quitRequested).toBe(true);
  });
});
