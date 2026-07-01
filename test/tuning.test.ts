import { describe, expect, it } from "vitest";
import { buildTrainingPosition } from "../src/benchmark/dataset.js";
import { tuneEvaluationWeights, tuneParameters, tunePolicyWeights } from "../src/benchmark/tuning.js";

describe("parameter tuning", () => {
  it("hill-climbs a simple scalar objective", () => {
    const result = tuneParameters(
      [{ name: "x", initial: 0, min: -5, max: 5, step: 1 }],
      (params) => -((params.x! - 3) ** 2),
      { iterations: 10 },
    );

    expect(result.parameters.x).toBe(3);
    expect(result.score).toBeCloseTo(0);
    expect(result.history.length).toBeGreaterThan(0);
  });

  it("runs the policy-weight tuning wrapper", () => {
    const pos = buildTrainingPosition("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "O-O", { bestMove: "O-O" });
    const result = tunePolicyWeights([pos], { epochs: 2 });

    expect(result.examples).toBe(1);
    expect(result.history).toHaveLength(2);
  });

  it("runs evaluation-weight tuning against eval labels", () => {
    const pos = buildTrainingPosition("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "O-O", {
      bestMove: "O-O",
      evalBefore: 25,
    });
    const result = tuneEvaluationWeights([pos], [{ name: "kingSafety", initial: 1, min: -2, max: 2, step: 0.5 }], {
      iterations: 2,
    });

    expect(result.examples).toBe(1);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
