import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CvsEngine } from "../src/engine.js";
import { runReferenceBenchmark } from "../src/benchmark/metrics.js";
import { perft, runPerft } from "../src/benchmark/perft.js";
import { runSpeedBenchmark } from "../src/benchmark/speed.js";
import { runBenchmarkSuite } from "../src/benchmark/orchestrator.js";
import { auditDataset } from "../src/benchmark/manifest.js";
import { summarizeGauntlet } from "../src/benchmark/gauntlet.js";
import { buildTrainingPosition, stringifyJsonl } from "../src/benchmark/dataset.js";
import { MOVE_FEATURE_KEYS, type MoveFeatures, type TrainingPosition } from "../src/types.js";
import type { PolicyWeights } from "../src/policy/weights.js";

const CASTLE_FEN = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
const KIWIPETE_FEN = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

function policyWeights(overrides: Partial<Record<keyof MoveFeatures, number>>): PolicyWeights {
  return {
    bias: 0,
    weights: Object.fromEntries(
      MOVE_FEATURE_KEYS.map((key) => [key, overrides[key] ?? 0]),
    ) as PolicyWeights["weights"],
  };
}

function castleBenchmarkPosition(): TrainingPosition {
  return buildTrainingPosition(CASTLE_FEN, "Kd2", {
    bestMove: "Kd2",
    topMoves: [
      { san: "Kd2", uci: "e1d2", cp: 100, depth: 10 },
      { san: "O-O", uci: "e1g1", cp: 0, depth: 10 },
      { san: "O-O-O", uci: "e1c1", cp: 0, depth: 10 },
    ],
  });
}

describe("reference benchmark v2", () => {
  it("computes cp loss from the engine move instead of dataset cpLoss", () => {
    const report = runReferenceBenchmark(
      [castleBenchmarkPosition()],
      new CvsEngine({ weights: policyWeights({ isCastle: 100 }) }),
      { depth: 0, topK: 3, blunderThresholdCp: 50 },
    );

    expect(report.summary.top1Match).toBe(0);
    expect(report.summary.avgCpLoss).toBe(100);
    expect(report.summary.blunderRate).toBe(1);
    expect(report.rows[0]!.reference.uci).toBe("e1d2");
    expect(["e1g1", "e1c1"]).toContain(report.rows[0]!.engine.uci);
  });

  it("reports bucket metrics by phase, source, terminal, tablebase, and motif", () => {
    const position = castleBenchmarkPosition();
    position.features.motifs = ["Open File"];
    const report = runReferenceBenchmark([position], new CvsEngine(), { depth: 0, topK: 3 });

    expect(report.rows[0]!.buckets.motifs).toContain("open-file");
    expect(report.summary.buckets.source.my_game.positions).toBe(1);
    expect(report.summary.buckets.terminal.ongoing.positions).toBe(1);
    expect(Object.values(report.summary.buckets.phase)[0]!.positions).toBe(1);
    expect(Object.values(report.summary.buckets.tablebase)[0]!.positions).toBe(1);
    expect(report.summary.buckets.motif["open-file"]!.positions).toBe(1);
  });

  it("reports search top-k separately from policy top-k", () => {
    const report = runReferenceBenchmark([castleBenchmarkPosition()], new CvsEngine(), {
      depth: 1,
      topK: 2,
      searchTopK: 2,
    });

    expect(report.rows[0]!.policyTopK).toHaveLength(2);
    expect(report.rows[0]!.searchTopK.length).toBeGreaterThan(0);
    expect(typeof report.summary.searchTopKMatch).toBe("number");
  });
});

describe("perft benchmark", () => {
  it("matches known start-position node counts", () => {
    expect(perft("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 1)).toBe(20);
    expect(perft("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 2)).toBe(400);
  });

  it("matches the canonical Kiwipete node counts", () => {
    expect(perft(KIWIPETE_FEN, 1)).toBe(48);
    expect(perft(KIWIPETE_FEN, 2)).toBe(2039);
  });

  it("covers targeted move-generator rules in the built-in suite", () => {
    const report = runPerft([
      { fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", depth: 1, expected: 26 },
      { fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", depth: 1, expected: 7 },
      { fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", depth: 1, expected: 9 },
      { fen: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1", depth: 1, expected: 3 },
      { fen: "r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1", depth: 1, expected: 23 },
      { fen: "k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1", depth: 1, expected: 10 },
    ]);

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(6);
  });

  it("reports pass/fail rows for expected counts", () => {
    const report = runPerft([
      {
        name: "startpos d1",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        depth: 1,
        expected: 20,
      },
    ]);

    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.rows[0]!.passed).toBe(true);
  });
});

describe("speed benchmark", () => {
  it("reports search NPS against an explicit target", () => {
    const report = runSpeedBenchmark(
      [
        {
          name: "startpos",
          fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        },
      ],
      { depth: 1, targetNps: 1 },
    );

    expect(report.kind).toBe("speed");
    expect(report.positions).toBe(1);
    expect(report.totalNodes).toBeGreaterThan(0);
    expect(report.nps).toBeGreaterThan(0);
    expect(report.passed).toBe(true);
  });
});

describe("dataset audit manifest", () => {
  it("versions, checksums, deduplicates, and buckets benchmark datasets", () => {
    const position = castleBenchmarkPosition();
    const audit = auditDataset([position, position], {
      name: "castle-smoke",
      version: "2026.06",
      purpose: "release-test",
      scorePerspective: "white",
    });

    expect(audit.manifest.version).toBe("2026.06");
    expect(audit.manifest.checksum).toHaveLength(64);
    expect(audit.manifest.positions).toBe(2);
    expect(audit.manifest.uniquePositions).toBe(1);
    expect(audit.manifest.duplicates).toBe(1);
    expect(audit.manifest.allReferenceMovesLegal).toBe(true);
    expect(audit.manifest.scorePerspective).toBe("white");
    expect(audit.issues.some((issue) => issue.code === "duplicate-position")).toBe(true);
    expect(audit.deduplicatedPositions).toHaveLength(1);
  });
});

describe("gauntlet statistics", () => {
  it("reports Elo, SPRT, paired openings, and raw artifact paths", () => {
    const report = summarizeGauntlet(
      {
        engine: "cvs-current",
        opponent: "cvs-baseline",
        timeControl: "10+0.1",
        sprt: { elo0: 0, elo1: 50 },
      },
      [
        { result: "1-0", engineColor: "white", opponent: "cvs-baseline", mirroredPairId: "a", pgnPath: "a.pgn", uciLogPath: "a.log" },
        { result: "0-1", engineColor: "black", opponent: "cvs-baseline", mirroredPairId: "a", pgnPath: "a.pgn", uciLogPath: "b.log" },
      ],
    );

    expect(report.games).toBe(2);
    expect(report.tally.wins).toBe(2);
    expect(report.elo.elo).toBeGreaterThan(0);
    expect(report.sprt?.games).toBe(2);
    expect(report.pairedOpenings).toBe(true);
    expect(report.artifactPaths.pgn).toEqual(["a.pgn"]);
    expect(report.artifactPaths.uciLogs).toEqual(["a.log", "b.log"]);
  });
});

describe("benchmark orchestrator", () => {
  it("runs mixed reference and perft jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "cvs-bench-"));
    const dataset = join(dir, "positions.jsonl");
    writeFileSync(dataset, stringifyJsonl([castleBenchmarkPosition()]), "utf8");

    const report = runBenchmarkSuite({
      name: "smoke",
      version: "test",
      outputDir: dir,
      gates: {
        correctness: { requirePerft: true },
        reporting: { requireManifest: true, requireArtifacts: true },
      },
      jobs: [
        { kind: "reference", name: "reference-smoke", dataset, depth: 0, topK: 3, suiteType: "tactical" },
        {
          kind: "perft",
          name: "perft-smoke",
          cases: [
            {
              fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
              depth: 1,
              expected: 20,
            },
          ],
        },
      ],
    });

    expect(report.kind).toBe("suite");
    expect(report.schemaVersion).toBe(2);
    expect(report.manifest.version).toBe("test");
    expect(report.jobs).toHaveLength(2);
    expect(report.jobs.every((job) => job.status === "ok")).toBe(true);
    expect(report.artifactPaths.length).toBeGreaterThan(0);
    expect(report.gates?.passed).toBe(true);
  });
});
