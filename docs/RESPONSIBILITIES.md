# TypeScript Engine Responsibilities

This package is the `@cvs/engine` baseline engine used by Chess Vision Studio
for policy/value/search experiments, dataset shaping, and TypeScript parity work.
It is a headless package: no React, browser storage, Vite bridge, or UI state.

## Package Role

| Layer | Responsibility |
|---|---|
| Feature layer | Extract position and move features from `chess.js` positions. |
| Policy head | Rank legal moves with stable feature keys and learned/hand-tuned weights. |
| Value head | Score positions with material, PST, phase, Rung-2 features, and trainable weights. |
| Search head | Turn value into best moves through negamax alpha-beta, quiescence, TT, and PV. |
| Dataset/benchmark layer | Convert CVS exports into training rows and measure top-1, top-k, cp loss, blunders, and mates. |
| CLI | Provide local analyze/predict/eval/features/selfplay/bench/uci commands. |

The package is not the deterministic teaching-facts authority. New facts for the
app's teaching contract belong in the Rust engine first.

## Architecture

```text
TrainingPosition / FEN
  -> features/positionFeatures.ts
  -> features/moveFeatures.ts + features/see.ts
  -> policy/policyEngine.ts ranks legal moves
  -> value/valueEngine.ts evaluates positions
  -> search/searchEngine.ts searches with value + ordering
  -> engine.ts exposes CvsEngine facade
  -> benchmark/* measures behavior against labelled data
```

## Schemas

| Schema | File | Responsibility |
|---|---|---|
| `PositionFeatures` | `src/types.ts` | Position-level material, king pressure, loose/hanging material, center control, mobility, safe moves, and motifs. |
| `MoveFeatures` | `src/types.ts` | Stable per-move feature vector consumed by policy weights and training. |
| `MOVE_FEATURE_KEYS` | `src/types.ts` | Canonical feature key order; changing it is a model/schema change. |
| `CandidateMove` | `src/types.ts` | Scored legal move with SAN, UCI, raw score, probability, and features. |
| `AnalysisResult` | `src/types.ts` | Full engine result: best move, score, mate, PV, depth, nodes, static eval, and policy candidates. |
| `TrainingPosition` | `src/types.ts` | Labelled supervised-learning example matching CVS analysis/export data. |
| `MoveTrainingRow` | `src/types.ts` | One legal-move row from a `TrainingPosition`, used by policy/ranking trainers. |
| `PolicyWeights` | `src/policy/weights.ts` | Linear policy feature weights and scaling. |
| `ValueWeights` | `src/value/weights.ts` | Base value-head material/PST/bishop-pair/tempo weights. |
| `Rung2Weights` | `src/value/rung2.ts` | Higher-level feature weights for mobility, king safety, pawns, rooks, and hanging pieces. |
| `SearchOptions` / `SearchResult` / `SearchTelemetry` | `src/search/searchEngine.ts` | Search knobs, returned best move/PV/score, and node telemetry. |
| `BenchmarkReport` | `src/benchmark/metrics.ts` | Aggregate measurement output. |

## Validation Standards

- `chess.js` owns legal moves, FEN validity, SAN/UCI application, checkmate, and
  stalemate in this package.
- Feature names are stable model inputs. Do not rename or reorder
  `MOVE_FEATURE_KEYS` without treating it as a model compatibility break.
- Search scores are side-to-move relative; `evaluateWhite` is White-relative.
  Keep this distinction explicit at boundaries.
- SEE and quiescence should prefer legality and conservative pruning over speed.
- Dataset builders should preserve unknown optional labels. Missing `cpLoss`,
  `topMoves`, or evals should not be replaced with fabricated labels.
- Benchmark claims must state dataset, depth, model weights, and search settings.
- Tests should cover feature extraction, search edge cases, train loops, UCI
  behavior, and schema helpers before changing exported interfaces.

## File Map

### Public Entry Points

| File | Responsibility |
|---|---|
| `src/index.ts` | Public export surface for engine, features, policy, value, search, benchmark, and dataset APIs. |
| `src/engine.ts` | `CvsEngine` facade composing policy, value, and search. |
| `bin/cvs-engine.ts` | CLI for analyze, predict, eval, features, selfplay, bench, and UCI mode. |
| `src/uci.ts` | UCI session implementation for external engine harnesses. |

### Shared Contracts and Helpers

| File | Responsibility |
|---|---|
| `src/types.ts` | Core data contracts for features, candidates, analysis, training positions, and rows. |
| `src/constants.ts` | Piece values, phase weights, mate scores, and center-square constants. |
| `src/board.ts` | Square math, king zones, king lookup, color opposite helper, and null-move FEN. |

### Feature Layer

| File | Responsibility |
|---|---|
| `src/features/see.ts` | Static exchange evaluation over a `chess.js` board. |
| `src/features/moveFeatures.ts` | Converts legal moves into the stable `MoveFeatures` vector. |
| `src/features/positionFeatures.ts` | Extracts `PositionFeatures` for material, pressure, mobility, loose pieces, hanging value, and center control. |

### Policy Head

| File | Responsibility |
|---|---|
| `src/policy/weights.ts` | Feature scaling and default policy weights. |
| `src/policy/policyEngine.ts` | Legal-move scoring, softmax probabilities, and top candidates. |
| `src/policy/train.ts` | Softmax/cross-entropy policy trainer over `TrainingPosition` data. |

### Value Head

| File | Responsibility |
|---|---|
| `src/value/pst.ts` | Piece-square tables and color/square lookup. |
| `src/value/weights.ts` | Base value-head weight schema and flatten/unflatten helpers. |
| `src/value/partials.ts` | Position partials and dot-product helpers for trainable value weights. |
| `src/value/valueEngine.ts` | Tapered material/PST evaluation, bishop pair, tempo, terminal handling, and side-relative eval. |
| `src/value/rung2.ts` | Rung-2 feature extraction, flattening, and weighted contribution. |
| `src/value/train.ts` | Regression trainer for base value weights. |
| `src/value/trainRanking.ts` | Preference/ranking trainer for value weights. |
| `src/value/trainMixed.ts` | Mixed regression plus sibling-ranking trainer over base and Rung-2 features. |

### Search Head

| File | Responsibility |
|---|---|
| `src/search/searchEngine.ts` | Negamax alpha-beta search, iterative deepening, quiescence, TT, move ordering, mate scoring, PV, and telemetry. |

### Benchmark and Dataset

| File | Responsibility |
|---|---|
| `src/benchmark/dataset.ts` | JSONL load/save, `TrainingPosition` builder, and legal-move row expansion. |
| `src/benchmark/metrics.ts` | Top-1/top-k/cp-loss/blunder/mate benchmark metrics. |

### Tests

| File | Responsibility |
|---|---|
| `test/engine.test.ts` | `CvsEngine` facade behavior. |
| `test/policy.test.ts` | Policy ranking and candidate behavior. |
| `test/value.test.ts` | Value-head scoring and terminal behavior. |
| `test/search.test.ts`, `test/search-boundary.test.ts` | Search, mate, PV, quiescence, TT, and boundary cases. |
| `test/see.test.ts` | Static exchange evaluation cases. |
| `test/dataset.test.ts` | Dataset parsing/building helpers. |
| `test/train.test.ts` | Training helpers. |
| `test/uci.test.ts` | UCI behavior. |

## Change Standards

When adding a move feature:

1. Add the field to `MoveFeatures`.
2. Append the key to `MOVE_FEATURE_KEYS`.
3. Add scaling in `src/policy/weights.ts`.
4. Populate it in `src/features/moveFeatures.ts`.
5. Update policy tests and any serialized model docs.

When changing value/search:

1. Keep `evaluateWhite` and side-to-move-relative `evaluate` semantics explicit.
2. Add a focused search or value test for the motivating position.
3. Benchmark against the same labelled dataset and depth before making strength
   claims.

When changing exported schemas:

1. Update `src/index.ts`.
2. Update README/API examples if public usage changes.
3. Update dataset builders and tests.

## Local Verification

```bash
npm test
npm run typecheck
npm run build
npm run engine -- analyze "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" --depth 2
```

