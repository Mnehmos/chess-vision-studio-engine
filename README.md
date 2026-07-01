# chess-vision-studio-engine

An experimental chess oracle — the engine side of
[Chess Vision Studio](https://github.com/Mnehmos/chess-vision-studio).

Chess Vision Studio is a Stockfish-backed evaluator, relationship visualizer,
and explanation system. This package is the next step described in its roadmap:
turning the rich, feature-labelled data CVS already produces into a **self-contained
engine that predicts moves and judges positions on its own**, split into the three
heads every modern engine needs.

```
policy   →  what moves are promising?      (ranks legal moves into a distribution)
value    →  who is better here?            (scores a position in centipawns)
search   →  what happens if both respond?  (negamax + quiescence look-ahead)
```

`CvsEngine` composes all three. It is `CVS-Policy-0`: a transparent,
feature-driven classical engine you can read, test, tune, and benchmark.

> **Status:** v0.1 classical baseline. This repository will not use NNUE,
> neural policy/value networks, or MCTS. The policy and value heads remain
> interpretable handcrafted/linear components; improvements happen through
> features, search, tuning, and benchmarks.

## Install & build

```bash
npm install
npm run build      # tsc -> dist/
npm run rust:build # release-build the native search core
npm test           # vitest
npm run typecheck
```

The chess backend is native TypeScript in `src/chess.ts`: FEN, legal move
generation, SAN/LAN, attack queries, make/undo, castling, en-passant, promotion,
and terminal-state checks all live inside this package.

## CLI

Run without building via `npm run engine -- <args>`, or after `npm run build`
via `node dist/bin/cvs-engine.js <args>`.

```bash
# Full analysis: search-backed best move + policy candidates + static eval
npm run engine -- analyze "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1" --depth 4

# Same analysis through the native Rust search core
npm run engine -- analyze "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1" --core rust --depth 4

# Policy-only move prediction (no search)
npm run engine -- predict "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" --k 5

# Static value evaluation (centipawns/100, White's perspective)
npm run engine -- eval "<fen>"

# Position-level features (the CVS `features` block)
npm run engine -- features "<fen>"

# Engine vs. itself
npm run engine -- selfplay --moves 20 --depth 3

# Benchmark against a labelled JSONL dataset
npm run engine -- bench dataset.jsonl --depth 0

# Full reference benchmark report with per-position rows
npm run engine -- bench reference dataset.jsonl --depth 3 --top-k 5 --search-top-k 3 --out reports/reference.json

# Dataset manifest/audit: checksum, dedupe, buckets, legal UCI/SAN references
npm run engine -- bench manifest dataset.jsonl --version 2026.06 --purpose validation --score-perspective white

# Move-generation correctness/performance benchmark
npm run engine -- bench perft

# Search speed benchmark with the release NPS floor
npm run engine -- bench speed --depth 4 --target-nps 1000000

# Native Rust search speed benchmark
npm run bench:speed:rust -- --depth 6 --target-nps 1000000

# Run a benchmark suite config
npm run engine -- bench suite benchmark-suite.json --out reports/suite.json
```

Example `analyze` output:

```
Best move:  exd5 (e4d5)
Score:      9.85 (depth 4, 3605 nodes)
Policy candidates:
  1. exd5     p=99.8%  see=900 score=9.920
  2. Nc3      p=0.0%   see=0   score=0.825
  ...
```

## UCI

The package also includes a Universal Chess Interface entry point for chess
GUIs and engine match runners.

```bash
# Run from source during development
npm run uci

# Same UCI loop through the main CLI
npm run engine -- uci

# After npm run build
node dist/bin/cvs-uci.js
node dist/bin/cvs-engine.js uci
npm run uci:dist

# Native Rust UCI core after npm run rust:build
npm run rust:uci
```

When installed as a package, the executable is `cvs-uci`. The UCI loop supports
the standard handshake/readiness commands plus `ucinewgame`, `position startpos`,
`position fen ...`, `go depth N`, `go movetime MS`, clock-budgeted `go`
commands, `go nodes N`, `go mate N`, `searchmoves`, ponder/`ponderhit`, `stop`,
and `quit`.

Use the built entry point (`node dist/bin/cvs-uci.js`, `npm run uci:dist`, or
the installed `cvs-uci`) for Cute Chess and other strength runners. `npm run uci`
uses TSX and is only a development launcher.

Example protocol exchange:

```text
uci
id name Chess Vision Studio Engine
id author Chess Vision Studio
option name Default Depth type spin default 4 min 1 max 64
option name Move Overhead type spin default 50 min 0 max 5000
option name MultiPV type spin default 1 min 1 max 32
option name Policy Ordering type check default true
option name Policy Ordering Weight type spin default 1000 min 0 max 100000
uciok
isready
readyok
position startpos moves e2e4 e7e5
go depth 3
info depth 3 seldepth 5 time 12 nodes 1234 nps 102833 hashfull 4 multipv 1 score cp 20 pv g1f3
bestmove g1f3
```

## Library API

```ts
import { CvsEngine } from "@cvs/engine";

const engine = new CvsEngine();
const fen = "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

engine.predict(fen, 5);          // top-5 candidate moves (policy only)
engine.evaluate(fen);            // static eval, centipawns (White's view)
engine.bestMove(fen, { depth: 4 });
engine.analyze(fen, { depth: 4, candidates: 5 }); // everything bundled
```

Lower-level pieces are exported too: `rankMoves`, `search` / `Searcher`,
`evaluate` / `evaluateWhite`, `see`, `computeMoveFeatures`,
`extractPositionFeatures`, `trainPolicy`, `benchmark`, and the dataset helpers.

## Tuning Data & Policy Ranker

The schema in `src/types.ts` (`TrainingPosition`) matches the Chess Vision Studio
analysis export, so a CVS ply folds straight into a labelled tuning row:

```ts
import { buildTrainingPosition, buildMoveRows, trainPolicy, saveDataset } from "@cvs/engine";

// (position, played move) -> labelled example with the full feature block
const pos = buildTrainingPosition(fen, "exd5", { bestMove: "exd5", cpLoss: 0 });

// expand into per-legal-move ranking rows (best move = label 1)
const rows = buildMoveRows(pos);

// tune policy weights by softmax ranking (Phase 3)
const { weights, history } = trainPolicy([pos /* ... */], { epochs: 100 });
const tuned = new CvsEngine({ weights });
```

The policy is a linear model over per-move features (capture, check, SEE,
PST delta, king-zone pressure, development, …). `DEFAULT_POLICY_WEIGHTS` is the
hand-tuned `CVS-Policy-0` prior; `trainPolicy` tunes it from data.

## Benchmarking

`benchmark(positions, engine, opts)` keeps the compact legacy summary. For real
runs, use `runReferenceBenchmark()` or the CLI `bench reference` command. The v2
reference report includes per-position rows, canonical UCI move comparison,
policy top-k, search multiPV top-k, engine cp-loss, blunder rate, mate
correctness, elapsed time, nodes, NPS, PV, abort reason, skipped rows, engine
failures, and per-bucket metrics by phase/source/motif/terminal/tablebase.

`bench manifest` audits JSONL datasets with checksums, normalized-FEN dedupe,
legal reference move validation, score-perspective checks, and bucket counts.
`bench perft` runs move-generation correctness/performance checks. `bench speed`
runs fixed-position search NPS checks against an explicit target; pass
`--core rust` to run the native speed core. `bench suite` runs mixed reference,
perft, and gauntlet-artifact jobs with suite manifests, environment metadata,
raw artifact paths, and optional release gates.

Speed is a release blocker for this classical engine. The minimum accepted
search speed target is **1,000,000 NPS** from the built UCI engine on the agreed
release hardware/suite. The TypeScript object-board core is the
correctness/reference implementation; the Rust core under `rust/cvs-core` is
the native path for hot search, perft, TT-backed PV extraction, MultiPV root
lines, cooperative UCI stop/time controls, and rich classical eval inspection.
Pass `--core rust` to CLI analysis/search commands that support native
delegation.

> First real target (per the roadmap): *pick a move within 0.50 pawns of
> Stockfish's best ≥ 70% of the time.* `avgCpLoss` and `top1Match` measure
> exactly that.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module-by-module detail.
See [`docs/NON_NNUE_ENGINE_CHECKLIST.md`](docs/NON_NNUE_ENGINE_CHECKLIST.md) for
the classical-engine hardening checklist.

```
src/
  constants.ts            piece values, phase weights, mate scores
  chess.ts                local chess backend boundary
  types.ts                TrainingPosition, MoveFeatures, AnalysisResult, …
  board.ts                square/king-zone helpers, null-move FEN
  value/  pst.ts          piece-square tables
          valueEngine.ts  tapered material + PST + bishop pair + tempo
          classicalTerms.ts pawn, king, mobility, files, minor, space terms
          incremental.ts evaluation-state update boundary
  features/ see.ts        static exchange evaluation
            moveFeatures.ts      per-move feature extraction
            positionFeatures.ts  the CVS `features` block
            motifs.ts            normalized motif taxonomy + detectors
  policy/  weights.ts     feature scaling + CVS-Policy-0 default weights
           policyEngine.ts softmax move ranker
           train.ts       softmax-ranking weight fitter
  search/  searchEngine.ts negamax alpha-beta + quiescence + classical heuristics
           zobrist.ts      Zobrist transposition-table keys
  engine.ts               CvsEngine facade (policy + value + search)
  benchmark/ metrics.ts   top-1/top-k, cpLoss, blunder & mate rates
             perft.ts     move-generation correctness/performance
             speed.ts     fixed-position search NPS gate
             orchestrator.ts benchmark suite runner
             manifest.ts  dataset manifests, checksums, dedupe, buckets
             stats.ts     Elo confidence intervals + SPRT
             gauntlet.ts  engine-vs-engine artifact summaries
             gates.ts     release gate evaluation
             tuning.ts    coordinate tuning for policy/eval parameters
             dataset.ts   JSONL + TrainingPosition builders
bin/cvs-engine.ts         CLI
rust/cvs-core/            native classical speed core
```

## Classical Roadmap

This repo is the classical engine. The roadmap improves native move generation,
handcrafted evaluation, linear policy features, alpha-beta search, UCI behavior,
and benchmark discipline. Neural-net work belongs in the separate neural engine.

| Phase | Roadmap goal | Status here |
|------:|--------------|-------------|
| 1 | Move predictor (policy) | ✅ `policyEngine` + `predict` |
| 2 | Tuning dataset shape | ✅ `TrainingPosition`, `buildTrainingPosition`, `buildMoveRows`, JSONL |
| 3 | Classical ranking model | ✅ linear features + `trainPolicy` (softmax ranking) |
| 4 | Value model + metrics | ✅ handcrafted `valueEngine` + benchmark suite |
| 5 | Search | ✅ negamax αβ + quiescence, policy-aware |
| 6 | Classical hardening | 🔜 perft, Zobrist, PVS, LMR, eval features, gauntlets |

The interfaces (`PolicyWeights`, the feature vectors, `evaluate`, `Searcher`)
are the seams for classical tuning and search/evaluation upgrades.

## License

MIT — see [LICENSE](LICENSE).
