import type { BenchmarkSuiteReport, BenchmarkJobReport } from "./orchestrator.js";

export interface ReleaseGateConfig {
  correctness?: {
    requirePerft?: boolean;
  };
  regression?: {
    minTop1Match?: number;
    maxAvgCpLoss?: number;
    maxBlunderRate?: number;
    maxEngineFailures?: number;
    maxSkippedRate?: number;
  };
  speed?: {
    minNps?: number;
  };
  strength?: {
    minElo?: number;
    requireSprtPass?: boolean;
  };
  reporting?: {
    requireManifest?: boolean;
    requireArtifacts?: boolean;
  };
}

export interface ReleaseGateResult {
  name: string;
  passed: boolean;
  details: string;
}

export interface ReleaseGateReport {
  passed: boolean;
  results: ReleaseGateResult[];
}

export function evaluateReleaseGates(
  report: BenchmarkSuiteReport,
  config: ReleaseGateConfig = {},
): ReleaseGateReport {
  const results: ReleaseGateResult[] = [];

  if (config.correctness?.requirePerft) {
    const perftJobs = okJobs(report.jobs).filter((job) => job.kind === "perft");
    const failures = perftJobs.reduce((sum, job) => sum + job.report.failed, 0);
    results.push({
      name: "correctness/perft",
      passed: perftJobs.length > 0 && failures === 0,
      details: `${perftJobs.length} perft job(s), ${failures} failed case(s)`,
    });
  }

  for (const job of okJobs(report.jobs)) {
    if (job.kind === "reference") {
      const summary = job.report.summary;
      if (typeof config.regression?.minTop1Match === "number") {
        results.push({
          name: `regression/${job.name}/top1`,
          passed: summary.top1Match >= config.regression.minTop1Match,
          details: `${summary.top1Match} >= ${config.regression.minTop1Match}`,
        });
      }
      if (typeof config.regression?.maxAvgCpLoss === "number") {
        results.push({
          name: `regression/${job.name}/cp-loss`,
          passed: summary.avgCpLoss <= config.regression.maxAvgCpLoss,
          details: `${summary.avgCpLoss} <= ${config.regression.maxAvgCpLoss}`,
        });
      }
      if (typeof config.regression?.maxBlunderRate === "number") {
        results.push({
          name: `regression/${job.name}/blunders`,
          passed: summary.blunderRate <= config.regression.maxBlunderRate,
          details: `${summary.blunderRate} <= ${config.regression.maxBlunderRate}`,
        });
      }
      if (typeof config.regression?.maxEngineFailures === "number") {
        results.push({
          name: `regression/${job.name}/engine-failures`,
          passed: summary.engineFailures <= config.regression.maxEngineFailures,
          details: `${summary.engineFailures} <= ${config.regression.maxEngineFailures}`,
        });
      }
      if (typeof config.regression?.maxSkippedRate === "number") {
        const skippedRate = summary.positions > 0 ? summary.skipped / summary.positions : 0;
        results.push({
          name: `regression/${job.name}/skipped`,
          passed: skippedRate <= config.regression.maxSkippedRate,
          details: `${skippedRate} <= ${config.regression.maxSkippedRate}`,
        });
      }
      if (typeof config.speed?.minNps === "number" && summary.totalNodes > 0) {
        results.push({
          name: `speed/${job.name}/nps`,
          passed: summary.nps >= config.speed.minNps,
          details: `${summary.nps} >= ${config.speed.minNps}`,
        });
      }
    }

    if (job.kind === "perft" && typeof config.speed?.minNps === "number") {
      results.push({
        name: `speed/${job.name}/nps`,
        passed: job.report.nps >= config.speed.minNps,
        details: `${job.report.nps} >= ${config.speed.minNps}`,
      });
    }

    if (job.kind === "gauntlet") {
      if (typeof config.strength?.minElo === "number") {
        results.push({
          name: `strength/${job.name}/elo`,
          passed: job.report.elo.elo >= config.strength.minElo,
          details: `${job.report.elo.elo} >= ${config.strength.minElo}`,
        });
      }
      if (config.strength?.requireSprtPass) {
        results.push({
          name: `strength/${job.name}/sprt`,
          passed: job.report.sprt?.decision === "accept-h1",
          details: job.report.sprt?.decision ?? "no SPRT report",
        });
      }
    }
  }

  if (config.reporting?.requireManifest) {
    results.push({
      name: "reporting/manifest",
      passed: Boolean(report.manifest),
      details: report.manifest ? report.manifest.checksum : "missing suite manifest",
    });
  }

  if (config.reporting?.requireArtifacts) {
    results.push({
      name: "reporting/artifacts",
      passed: report.artifactPaths.length > 0,
      details: `${report.artifactPaths.length} artifact path(s)`,
    });
  }

  return {
    passed: results.every((result) => result.passed),
    results,
  };
}

type OkJob = Extract<BenchmarkJobReport, { status: "ok" }>;

function okJobs(jobs: BenchmarkJobReport[]): OkJob[] {
  return jobs.filter((job): job is OkJob => job.status === "ok");
}
