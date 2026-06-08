import { describe, expect, it } from "vitest";
import { featuresForAllMoves } from "../src/features/moveFeatures.js";
import { buildTrainingPosition } from "../src/benchmark/dataset.js";
import { trainPolicy } from "../src/policy/train.js";
import type { TrainingPosition } from "../src/types.js";

// A handful of positions where the clearly best move is the highest-SEE capture.
const FENS = [
  "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1", // exd5 wins queen
  "4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1", // exd5 wins rook
  "4k3/8/8/3b4/4P3/8/8/4K3 w - - 0 1", // exd5 wins bishop
  "4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", // exd5 wins knight
];

function highestSeeMoveSan(fen: string): string {
  const rows = featuresForAllMoves(fen);
  rows.sort((a, b) => b.features.see - a.features.see);
  return rows[0]!.move.san;
}

describe("trainPolicy", () => {
  const positions: TrainingPosition[] = FENS.map((fen) =>
    buildTrainingPosition(fen, highestSeeMoveSan(fen), { bestMove: highestSeeMoveSan(fen) }),
  );

  it("uses every well-formed position as an example", () => {
    const result = trainPolicy(positions, { epochs: 5 });
    expect(result.examples).toBe(FENS.length);
  });

  it("decreases cross-entropy loss over training", () => {
    const result = trainPolicy(positions, { epochs: 120, learningRate: 0.5 });
    const first = result.history[0]!.loss;
    const last = result.history.at(-1)!.loss;
    expect(last).toBeLessThan(first);
  });

  it("learns to rank the winning capture first", () => {
    const result = trainPolicy(positions, { epochs: 200, learningRate: 0.5 });
    expect(result.history.at(-1)!.top1Accuracy).toBe(1);
    // A positive weight on SEE is the obvious thing to learn here.
    expect(result.weights.weights.see).toBeGreaterThan(0);
  });
});
