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
feature-driven baseline you can read, test, and benchmark — and the seed a
learned policy/value model later grows from.

> **Status:** v0.1 baseline. The policy and value heads are interpretable
> handcrafted/linear models, not neural nets. The point is a working,
> measurable foundation — see [the roadmap](#roadmap) for where it goes.

## Install & build

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (29 tests)
npm run typecheck
```

Runtime dependency: [`chess.js`](https://github.com/jhlywa/chess.js) for legal
move generation, FEN handling, and attacker queries.

## CLI

Run without building via `npm run engine -- <args>`, or after `npm run build`
via `node dist/bin/cvs-engine.js <args>`.

```bash
# Full analysis: search-backed best move + policy candidates + static eval
npm run engine -- analyze "rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1" --depth 4

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

## Training data & the policy ranker

The schema in `src/types.ts` (`TrainingPosition`) matches the Chess Vision Studio
analysis export, so a CVS ply folds straight into a training row:

```ts
import { buildTrainingPosition, buildMoveRows, trainPolicy, saveDataset } from "@cvs/engine";

// (position, played move) -> labelled example with the full feature block
const pos = buildTrainingPosition(fen, "exd5", { bestMove: "exd5", cpLoss: 0 });

// expand into per-legal-move ranking rows (best move = label 1)
const rows = buildMoveRows(pos);

// learn policy weights by softmax ranking (Phase 3)
const { weights, history } = trainPolicy([pos /* ... */], { epochs: 100 });
const tuned = new CvsEngine({ weights });
```

The policy is a linear model over per-move features (capture, check, SEE,
PST delta, king-zone pressure, development, …). `DEFAULT_POLICY_WEIGHTS` is the
hand-tuned `CVS-Policy-0` prior; `trainPolicy` refines it from data.

## Benchmarking

`benchmark(positions, engine, opts)` reports the measurable ladder from the
roadmap: **top-1 match**, **top-k overlap**, **average centipawn loss**,
**blunder rate**, and **mate-detection rate** against a reference (e.g.
Stockfish's best move stored in the dataset).

> First real target (per the roadmap): *pick a move within 0.50 pawns of
> Stockfish's best ≥ 70% of the time.* `avgCpLoss` and `top1Match` measure
> exactly that.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module-by-module detail.

```
src/
  constants.ts            piece values, phase weights, mate scores
  types.ts                TrainingPosition, MoveFeatures, AnalysisResult, …
  board.ts                square/king-zone helpers, null-move FEN
  value/  pst.ts          piece-square tables
          valueEngine.ts  tapered material + PST + bishop pair + tempo
  features/ see.ts        static exchange evaluation
            moveFeatures.ts      per-move feature extraction
            positionFeatures.ts  the CVS `features` block
  policy/  weights.ts     feature scaling + CVS-Policy-0 default weights
           policyEngine.ts softmax move ranker
           train.ts       softmax-ranking trainer
  search/  searchEngine.ts negamax αβ + quiescence + TT
  engine.ts               CvsEngine facade (policy + value + search)
  benchmark/ metrics.ts   top-1/top-k, cpLoss, blunder & mate rates
             dataset.ts   JSONL + TrainingPosition builders
bin/cvs-engine.ts         CLI
```

## Roadmap

This repo implements the baseline rungs; later rungs swap the handcrafted heads
for learned ones without changing the interfaces.

| Phase | Roadmap goal | Status here |
|------:|--------------|-------------|
| 1 | Move predictor (policy) | ✅ `policyEngine` + `predict` |
| 2 | Training dataset shape | ✅ `TrainingPosition`, `buildTrainingPosition`, `buildMoveRows`, JSONL |
| 3 | Baseline ranking model | ✅ linear features + `trainPolicy` (softmax ranking) |
| 4 | Value model + metrics | ✅ handcrafted `valueEngine` + `benchmark`; learned value model is next |
| 5 | Search | ✅ negamax αβ + quiescence, policy-aware |
| — | Learned policy/value (NN), MCTS, Stockfish data pipeline | 🔜 future work |

The interfaces (`PolicyWeights`, the feature vectors, `evaluate`, `Searcher`)
are deliberately the seams where a trained model drops in.

## License

MIT — see [LICENSE](LICENSE).
