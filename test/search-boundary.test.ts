import { describe, expect, it } from "vitest";
import { CvsEngine } from "../src/engine.js";
import { Searcher } from "../src/search/searchEngine.js";
import type { ValueWeights } from "../src/value/weights.js";
import type { Rung2Weights } from "../src/value/rung2.js";

// Fixture: the Rung-2 mixed weights (α=1, β=1) under which the depth-4 horizon
// blunder at dataset index 549 was first observed. Embedded so this regression is
// permanent and self-contained (independent of the gitignored arena/out artifacts).
const MIXED_BASE: ValueWeights = {
  material: { p: 0.9771941394330501, n: 0.9472182607514921, b: 0.9749786048046231, r: 0.9692686197283779, q: 0.9808573066642514 },
  pstScale: 1.0132826900617409,
  bishopPair: 27.855206547893538,
  tempo: 12.353636757965402,
};
const MIXED_RUNG2: Rung2Weights = {
  mobilityKnight: 0.3446948773300695,
  mobilityBishop: 2.4737715292977267,
  mobilityRook: 1.228760832057703,
  mobilityQueen: 0.5667502267756924,
  kingShield: 1.1851233890189907,
  kingZonePressure: 4.907791717892074,
  kingOpenFile: 4.287137678536876,
  passedPawnMg: 0.8814455206517932,
  passedPawnEg: 1.1306107911887235,
  connectedPassedPawn: 3.2949975972383156,
  rookOpenFile: 2.9742065689960477,
  rookSemiOpenFile: 10.791224386274036,
  rookSeventh: 3.182875456707168,
  doubledPawn: 2.8046149341674074,
  isolatedPawn: -0.91588157836913,
  bishopPairMg: -1.6363672647332876,
  bishopPairEg: -0.5084261873731701,
  hangingPiece: 11.6631476916599,
};

// The d4 horizon blunder. Before the forcing-quiet quiescence extension, the
// mixed eval played b3f7 (Bf7) here at depth 4 — a 2.18-pawn blunder whose quiet
// refutation lived beyond the capture-only quiescence. SF/default best ≈ Rf7 (h7f7).
const D4_BLUNDER_FEN = "5r2/pp5R/1kp3p1/6b1/4P1b1/1BNP2P1/PPP4P/1K6 w - - 1 22";

describe("search boundary — forcing quiet quiescence", () => {
  it("REGRESSION (d4 horizon blunder #549): mixed eval no longer plays the refuted Bf7 at depth 4", () => {
    const eng = new CvsEngine({ valueWeights: MIXED_BASE, rung2Weights: MIXED_RUNG2 });
    const pick = eng.bestMove(D4_BLUNDER_FEN, { depth: 4 });
    expect(pick).not.toBeNull();
    // b3f7 is the quiet-refuted blunder; the quiescence check-extension must avoid it.
    expect(pick!.uci).not.toBe("b3f7");
  });

  it("populates quiescence telemetry", () => {
    const r = new Searcher().search(D4_BLUNDER_FEN, { depth: 4 });
    expect(r.telemetry).toBeDefined();
    expect(r.telemetry!.qNodes).toBeGreaterThan(0);
    expect(r.telemetry!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps quiet extensions strictly bounded (no quiescence explosion)", () => {
    const r = new Searcher().search(D4_BLUNDER_FEN, { depth: 4 });
    // qDepth-gated + per-node capped, so the quiescence stays shallow and the
    // extension nodes are a subset of quiescence nodes.
    expect(r.telemetry!.maxQDepth).toBeLessThan(40);
    expect(r.telemetry!.quietExtensionNodes).toBeLessThanOrEqual(r.telemetry!.qNodes);
    expect(r.telemetry!.mateThreatExtensions).toBe(0); // scaffolded, not yet implemented
    expect(r.telemetry!.hangingMajorPieceExtensions).toBe(0);
  });
});
