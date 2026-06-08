import { describe, expect, it } from "vitest";
import {
  buildMoveRows,
  buildTrainingPosition,
  parseJsonl,
  stringifyJsonl,
} from "../src/benchmark/dataset.js";
import { benchmark } from "../src/benchmark/metrics.js";
import { CvsEngine } from "../src/engine.js";

const HANGING_QUEEN_FEN = "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

describe("dataset utilities", () => {
  it("builds a training position with side, legal moves and features", () => {
    const pos = buildTrainingPosition(HANGING_QUEEN_FEN, "exd5", { bestMove: "exd5" });
    expect(pos.sideToMove).toBe("w");
    expect(pos.legalMoves).toContain("exd5");
    expect(pos.features.phase).toBeDefined();
    // Black's queen is hanging, so White's "hanging value against Black" is high.
    expect(pos.features.hangingValueBlack).toBeGreaterThan(800);
  });

  it("labels exactly one move row as the best move", () => {
    const pos = buildTrainingPosition(HANGING_QUEEN_FEN, "exd5", { bestMove: "exd5" });
    const rows = buildMoveRows(pos);
    const positives = rows.filter((r) => r.label === 1);
    expect(positives.length).toBe(1);
    expect(positives[0]!.san).toBe("exd5");
  });

  it("round-trips through JSONL", () => {
    const pos = buildTrainingPosition(HANGING_QUEEN_FEN, "exd5", {
      bestMove: "exd5",
      cpLoss: 0,
      source: "stockfish_selfplay",
    });
    const restored = parseJsonl(stringifyJsonl([pos]));
    expect(restored.length).toBe(1);
    expect(restored[0]!.fen).toBe(pos.fen);
    expect(restored[0]!.source).toBe("stockfish_selfplay");
  });
});

describe("benchmark", () => {
  it("scores a perfect top-1 match when the reference is the engine's pick", () => {
    const pos = buildTrainingPosition(HANGING_QUEEN_FEN, "exd5", {
      bestMove: "exd5",
      cpLoss: 0,
    });
    const report = benchmark([pos], new CvsEngine(), { depth: 0 });
    expect(report.positions).toBe(1);
    expect(report.top1Match).toBe(1);
    expect(report.topKMatch).toBe(1);
    expect(report.avgCpLoss).toBe(0);
  });
});
