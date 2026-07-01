import { describe, expect, it } from "vitest";
import { detectMotifs, normalizeMotif, SUPPORTED_MOTIFS } from "../src/features/motifs.js";

describe("motif detection", () => {
  it("publishes normalized labels for the checklist motif taxonomy", () => {
    expect(SUPPORTED_MOTIFS).toContain(normalizeMotif("Anastasia's mate"));
    expect(SUPPORTED_MOTIFS).toContain(normalizeMotif("protected passed pawn"));
    expect(SUPPORTED_MOTIFS).toContain(normalizeMotif("windmill - knight fork"));
    expect(SUPPORTED_MOTIFS).toContain(normalizeMotif("Alekhine's gun"));
  });

  it("detects representative pawn-structure motifs", () => {
    const motifs = detectMotifs("4k3/8/8/3P4/2PP4/8/4P3/4K3 w - - 0 1");

    expect(motifs).toContain("connected-pawns");
    expect(motifs).toContain("doubled-pawns");
    expect(motifs).toContain("passed-pawn");
    expect(motifs).toContain("protected-passed-pawn");
  });

  it("detects tactical move motifs from legal moves", () => {
    const motifs = detectMotifs("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");

    expect(motifs).toContain("en-passant");
    expect(motifs).toContain("pawn-grab");
  });

  it("detects line and mate motifs", () => {
    const pin = detectMotifs("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(pin).toContain("pin");
    expect(pin).toContain("x-ray");

    const mateThreat = detectMotifs("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1");
    expect(mateThreat).toContain("mate-threat");
    expect(mateThreat).toContain("back-rank-mate");
  });
});
