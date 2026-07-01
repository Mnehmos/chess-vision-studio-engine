import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CvsEngine, type SearchCore } from "../engine.js";
import type { DatasetPurpose, ScorePerspective } from "../types.js";
import { loadDataset } from "./dataset.js";
import { summarizeGauntlet, type GauntletConfig, type GauntletGame, type GauntletReport } from "./gauntlet.js";
import { evaluateReleaseGates, type ReleaseGateConfig, type ReleaseGateReport } from "./gates.js";
import { auditDataset, checksumValue, createEnvironment, type BenchmarkEnvironment, type DatasetAuditIssue, type DatasetManifest } from "./manifest.js";
import {
  runReferenceBenchmark,
  type BenchmarkOptions,
  type ReferenceBenchmarkReport,
} from "./metrics.js";
import {
  BUILTIN_PERFT_CASES,
  runPerft,
  type PerftCase,
  type PerftReport,
} from "./perft.js";

export type BenchmarkJobConfig = ReferenceBenchmarkJobConfig | PerftBenchmarkJobConfig | GauntletBenchmarkJobConfig;

export interface ReferenceBenchmarkJobConfig extends BenchmarkOptions {
  kind: "reference";
  name?: string;
  dataset: string;
  core?: SearchCore;
  suiteType?: "tactical" | "positional" | "reference-analysis";
  purpose?: DatasetPurpose;
  scorePerspective?: ScorePerspective;
  deduplicate?: boolean;
}

export interface PerftBenchmarkJobConfig {
  kind: "perft";
  name?: string;
  suite?: string;
  cases?: PerftCase[];
  depth?: number;
}

export interface GauntletBenchmarkJobConfig {
  kind: "gauntlet";
  name?: string;
  config: GauntletConfig;
  games?: GauntletGame[];
  results?: string;
}

export interface BenchmarkSuiteConfig {
  name?: string;
  version?: string;
  purpose?: DatasetPurpose;
  seed?: number | string;
  outputDir?: string;
  artifactDir?: string;
  core?: SearchCore;
  gates?: ReleaseGateConfig;
  settings?: Record<string, unknown>;
  jobs: BenchmarkJobConfig[];
}

export interface BenchmarkRunOptions {
  /** Base directory for relative dataset/suite paths. */
  baseDir?: string;
  /** Optional output path for the full JSON report. */
  out?: string;
}

export interface BenchmarkSuiteManifest {
  schemaVersion: 1;
  kind: "benchmark-suite-manifest";
  name: string;
  version: string;
  checksum: string;
  checksumAlgorithm: "sha256";
  purpose: DatasetPurpose | "unspecified";
  seed?: number | string;
  jobCount: number;
  settings?: Record<string, unknown>;
}

export type BenchmarkJobReport =
  | {
      kind: "reference";
      name: string;
      status: "ok";
      elapsedMs: number;
      suiteType: "tactical" | "positional" | "reference-analysis";
      manifest: DatasetManifest;
      auditIssues: DatasetAuditIssue[];
      artifactPath?: string;
      report: ReferenceBenchmarkReport;
    }
  | {
      kind: "perft";
      name: string;
      status: "ok";
      elapsedMs: number;
      manifest: {
        checksum: string;
        checksumAlgorithm: "sha256";
        positions: number;
      };
      artifactPath?: string;
      report: PerftReport;
    }
  | {
      kind: "gauntlet";
      name: string;
      status: "ok";
      elapsedMs: number;
      manifest: {
        checksum: string;
        checksumAlgorithm: "sha256";
        games: number;
      };
      artifactPath?: string;
      report: GauntletReport;
    }
  | {
      kind: BenchmarkJobConfig["kind"];
      name: string;
      status: "error";
      elapsedMs: number;
      artifactPath?: string;
      error: string;
    };

type OkBenchmarkJobReport = Extract<BenchmarkJobReport, { status: "ok" }>;
type PendingOkBenchmarkJobReport = OkBenchmarkJobReport extends infer T
  ? T extends unknown
    ? Omit<T, "elapsedMs" | "artifactPath">
    : never
  : never;

export interface BenchmarkSuiteReport {
  schemaVersion: 2;
  kind: "suite";
  name: string;
  version: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  environment: BenchmarkEnvironment;
  manifest: BenchmarkSuiteManifest;
  artifactPaths: string[];
  gates?: ReleaseGateReport;
  jobs: BenchmarkJobReport[];
}

export function loadBenchmarkSuite(path: string): BenchmarkSuiteConfig {
  return JSON.parse(readFileSync(path, "utf8")) as BenchmarkSuiteConfig;
}

export function loadPerftCases(path: string): PerftCase[] {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return parseJsonlCases(text);
  const parsed = JSON.parse(text) as PerftCase[] | { cases: PerftCase[] };
  return Array.isArray(parsed) ? parsed : parsed.cases;
}

export function runBenchmarkSuite(
  config: BenchmarkSuiteConfig,
  options: BenchmarkRunOptions = {},
): BenchmarkSuiteReport {
  const startedAt = new Date();
  const started = Date.now();
  const runId = `${slug(config.name ?? "benchmark")}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  const baseDir = options.baseDir ?? process.cwd();
  const output = options.out ?? defaultOutputPath(config, runId, baseDir);
  const artifactDir = defaultArtifactDir(config, output, baseDir);
  const artifactPaths = output ? [output] : [];
  const jobs: BenchmarkJobReport[] = [];

  for (const [index, job] of config.jobs.entries()) {
    const jobStarted = Date.now();
    const name = job.name ?? `${job.kind}-${index + 1}`;
    try {
      const report = runJob(job, name, config, baseDir);
      const artifactPath = writeJobArtifact(artifactDir, runId, name, report);
      if (artifactPath) artifactPaths.push(artifactPath);
      jobs.push({ ...report, artifactPath, elapsedMs: Date.now() - jobStarted } as BenchmarkJobReport);
    } catch (error) {
      jobs.push({
        kind: job.kind,
        name,
        status: "error",
        elapsedMs: Date.now() - jobStarted,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: BenchmarkSuiteReport = {
    schemaVersion: 2,
    kind: "suite",
    name: config.name ?? "benchmark-suite",
    version: config.version ?? "unversioned",
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    environment: createEnvironment(process.cwd()),
    manifest: suiteManifest(config),
    artifactPaths,
    jobs,
  };

  if (config.gates) report.gates = evaluateReleaseGates(report, config.gates);
  if (output) writeJson(output, report);

  return report;
}

export function runBenchmarkSuiteFile(
  path: string,
  options: Omit<BenchmarkRunOptions, "baseDir"> = {},
): BenchmarkSuiteReport {
  const config = loadBenchmarkSuite(path);
  return runBenchmarkSuite(config, {
    ...options,
    baseDir: dirname(resolve(path)),
  });
}

function runJob(
  job: BenchmarkJobConfig,
  name: string,
  suite: BenchmarkSuiteConfig,
  baseDir: string,
): PendingOkBenchmarkJobReport {
  if (job.kind === "reference") {
    const datasetPath = resolveFrom(baseDir, job.dataset);
    const positions = loadDataset(datasetPath);
    const audit = auditDataset(positions, {
      name,
      version: suite.version,
      purpose: job.purpose ?? suite.purpose,
      scorePerspective: job.scorePerspective,
      source: datasetPath,
    });
    const benchmarkPositions = job.deduplicate === false ? positions : audit.deduplicatedPositions;
    return {
      kind: "reference",
      name,
      status: "ok",
      suiteType: job.suiteType ?? "reference-analysis",
      manifest: audit.manifest,
      auditIssues: audit.issues,
      report: runReferenceBenchmark(
        benchmarkPositions,
        new CvsEngine({ searchCore: job.core ?? suite.core }),
        job,
      ),
    };
  }

  if (job.kind === "perft") {
    const cases = perftCasesForJob(job, baseDir);
    return {
      kind: "perft",
      name,
      status: "ok",
      manifest: {
        checksum: checksumValue(cases),
        checksumAlgorithm: "sha256",
        positions: cases.length,
      },
      report: runPerft(cases),
    };
  }

  const games = gauntletGamesForJob(job, baseDir);
  return {
    kind: "gauntlet",
    name,
    status: "ok",
    manifest: {
      checksum: checksumValue({ config: job.config, games }),
      checksumAlgorithm: "sha256",
      games: games.length,
    },
    report: summarizeGauntlet({ ...job.config, name: job.config.name ?? name }, games),
  };
}

function perftCasesForJob(job: PerftBenchmarkJobConfig, baseDir: string): PerftCase[] {
  const cases = job.suite ? loadPerftCases(resolveFrom(baseDir, job.suite)) : (job.cases ?? BUILTIN_PERFT_CASES);
  if (job.depth === undefined) return cases;
  return cases.map((testCase) => ({
    ...testCase,
    depth: job.depth!,
    expected: undefined,
  }));
}

function gauntletGamesForJob(job: GauntletBenchmarkJobConfig, baseDir: string): GauntletGame[] {
  if (!job.results) return job.games ?? [];
  const parsed = JSON.parse(readFileSync(resolveFrom(baseDir, job.results), "utf8")) as GauntletGame[] | { games: GauntletGame[] };
  return Array.isArray(parsed) ? parsed : parsed.games;
}

function parseJsonlCases(text: string): PerftCase[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PerftCase);
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function defaultOutputPath(
  config: BenchmarkSuiteConfig,
  runId: string,
  baseDir: string,
): string | undefined {
  if (!config.outputDir) return undefined;
  return join(resolveFrom(baseDir, config.outputDir), `${runId}.json`);
}

function defaultArtifactDir(
  config: BenchmarkSuiteConfig,
  output: string | undefined,
  baseDir: string,
): string | undefined {
  if (config.artifactDir) return resolveFrom(baseDir, config.artifactDir);
  if (config.outputDir) return resolveFrom(baseDir, config.outputDir);
  return output ? dirname(output) : undefined;
}

function writeJobArtifact(
  artifactDir: string | undefined,
  runId: string,
  name: string,
  value: unknown,
): string | undefined {
  if (!artifactDir) return undefined;
  const path = join(artifactDir, `${runId}-${slug(name)}.json`);
  writeJson(path, value);
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function suiteManifest(config: BenchmarkSuiteConfig): BenchmarkSuiteManifest {
  return {
    schemaVersion: 1,
    kind: "benchmark-suite-manifest",
    name: config.name ?? "benchmark-suite",
    version: config.version ?? "unversioned",
    checksum: checksumValue({
      name: config.name,
      version: config.version,
      purpose: config.purpose,
      seed: config.seed,
      settings: config.settings,
      jobs: config.jobs,
    }),
    checksumAlgorithm: "sha256",
    purpose: config.purpose ?? "unspecified",
    seed: config.seed,
    jobCount: config.jobs.length,
    settings: config.settings,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "benchmark";
}
