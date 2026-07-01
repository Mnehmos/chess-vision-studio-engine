# Architecture

The engine is three cooperating heads plus the feature layer they share. This is
the classical Chess Vision Studio engine: no NNUE, neural policy/value network,
or MCTS belongs in this repository. Every component is a transparent, testable
function so the baseline (`CVS-Policy-0`) is fully legible and tunable.

```
                 ┌────────────────────────────────────────────┐
                 │                 CvsEngine                   │
                 │  predict() · evaluate() · bestMove() ·      │
                 │  analyze()                                  │
                 └───────────────┬─────────────┬───────────────┘
                                 │             │
        ┌────────────────────────┘             └──────────────────────┐
        ▼                                                              ▼
  ┌───────────┐         ┌───────────┐                          ┌────────────┐
  │  policy   │◀────────│  features │────────▶ value ──────────▶│   search   │
  │ (ranker)  │  move + │ (see,move,│   material/PST eval       │ negamax αβ │
  │           │ position│ position) │                           │ + quiesce  │
  └───────────┘ features└───────────┘                          └────────────┘
```

## Shared layer

### `constants.ts`
Classical centipawn `PIECE_VALUE` (P=100 … Q=900, K=20000), `PHASE_VALUE` for
the opening→endgame taper (`MAX_PHASE = 24`), `MATE_SCORE`, and the center-square
sets. Keeping material values classical makes the value engine's output directly
comparable to Stockfish-style centipawns.

### `chess.ts`
The native chess backend. It owns FEN load/save, legal move generation, SAN/LAN,
attack queries, make/undo, castling, en-passant, promotion, and terminal-state
checks. Engine modules import `Chess` and chess types from here instead of from
an external rules package.

### `board.ts`
Square helpers (`fileOf`, `rankOf`, `squareFrom`), `kingZone` (the 8 squares
around a king), `kingSquare`, and `nullMoveFen` — a side-to-move flip used to
measure the *other* side's mobility without playing a real move.

### `types.ts`
The data contracts:
- `MoveFeatures` — 14 per-move signals (capture, check, promotion, castle,
  en-passant, SEE, capture value, escapes-attack, moves-into-danger, PST delta,
  develops, attacks-king-zone, moves-to-center, creates-threat). The keys are
  stable: they are the policy weight-vector keys.
- `PositionFeatures` — the position-level block, field-for-field the same shape
  CVS exports (phase, material balance, king pressure, loose/hanging material,
  center control, mobility, safe moves, motifs).
- `TrainingPosition` — one labelled tuning example for policy fitting.
- `AnalysisResult`, `CandidateMove`, `MoveTrainingRow`.

## Features

### `features/see.ts` — Static Exchange Evaluation
Given a move `from → to`, simulates the full capture sequence on the destination
square and returns the net centipawn swing for the moving side. It runs on a
mutable chess backend clone, re-querying `attackers()` after each capture so x-ray
attackers (a rook behind a rook, a queen behind a bishop) are revealed
naturally, and uses the standard least-valuable-attacker + minimax swap list.
Kings only participate as the final capturer when the square is undefended.

SEE is the backbone of both move quality (policy) and pruning (quiescence).

### `features/moveFeatures.ts`
Turns a verbose chess-backend move into a `MoveFeatures` vector. The post-move
picture (king-zone attacks, new threats) is read from the move's `after` FEN.

### `features/positionFeatures.ts`
Computes the full `PositionFeatures` block for a FEN: material balance, king
pressure (enemy attacks into the king zone), loose pieces (attacked & undefended),
hanging value (best enemy SEE per piece), center control, and mobility / safe
moves for both sides (the off-turn side via `nullMoveFen`).

### `features/motifs.ts`
Normalized ChessTempo-style motif taxonomy plus deterministic first-pass
detectors for pawn structure, lines, coordination, king safety, mate threats,
tactical move types, pins/skewers/x-rays, and other explanation labels.

## Value head — `value/`

### `pst.ts`
Classical "simplified evaluation" piece-square tables in visual (rank-8-first)
order, with separate middlegame/endgame king tables. `pstValueMg` / `pstValueEg`
map a (piece, color, square) to a bonus, mirroring vertically for Black.

### `valueEngine.ts`
`evaluateWhite(chess)` returns centipawns from White's perspective:
**tapered material + PST**, a **bishop-pair** bonus, and a small **tempo** term;
terminal positions short-circuit to mate/stalemate scores. `evaluate(chess)`
returns the side-to-move-relative score the negamax search consumes. `phaseUnits`
/ `phaseLabel` classify opening/middlegame/endgame from remaining non-pawn
material. This handcrafted evaluator remains the value head for this classical
engine; improvements are added as explicit evaluation terms, scaling rules, and
tuned weights.

### `classicalTerms.ts` and `incremental.ts`
Classical evaluator terms beyond material/PST: pawn structure, king safety,
piece-type mobility, open/semi-open files and seventh ranks, minor-piece quality,
space/center control, and endgame scaling. `incremental.ts` exposes the
evaluation-state boundary; it recomputes today and can be optimized later behind
the same API.

## Policy head — `policy/`

### `weights.ts`
`FEATURE_SCALE` normalizes centipawn-scale features (SEE, capture value, PST
delta) and 0/1 indicators into one O(1) range, used identically for scoring and
tuning. `DEFAULT_POLICY_WEIGHTS` is `CVS-Policy-0`: hand-tuned priors that
reward safe captures/checks/promotions and development while punishing
moving-into-danger.

### `policyEngine.ts`
`rankMoves(fen)` scores every legal move with the linear model and applies a
softmax (with temperature) to produce a probability distribution, sorted highest
first. `topCandidates` slices the top-k. This is the move-prediction head and the
move-ordering prior for search.

### `train.ts`
`trainPolicy(positions)` fits the linear policy weight vector by **softmax
(cross-entropy) ranking**: each position's best/played move is the positive
class, the other legal moves are negatives. Full-batch gradient descent with L2;
returns weights plus a per-epoch loss / top-1-accuracy history. (The bias is
left at 0 because softmax is invariant to a constant logit shift, so it is
unidentifiable from ranking.)

## Search head — `search/searchEngine.ts`

A `Searcher` running **negamax alpha-beta** with:
- **iterative deepening** to a depth (or wall-clock) budget,
- a **transposition table** keyed by Zobrist hash with exact/lower/upper bounds,
- **MVV-LVA move ordering** (TT move first, then captures by victim/attacker,
  promotions), killer/history/countermove heuristics, and root policy-logit
  ordering,
- aspiration windows, principal variation search, check/recapture extensions,
  late-move reductions, null-move pruning, shallow futility/reverse-futility,
  and capture ordering tuned for the classical evaluator,
- a **capture quiescence search** that stands pat on the static eval, searches
  captures/promotions, and searches all evasions when in check,
- distance-scaled **mate scoring** so shorter mates are preferred, surfaced as a
  signed `mate` ply count, and a reconstructed **principal variation**.

It calls a fast search evaluator at the leaves. The richer public evaluator keeps
the classical analysis terms for reporting and tuning, while search avoids
expensive SAN/FEN/legal-move allocation in the hot path where practical.

## Composition — `engine.ts`

`CvsEngine` wires the heads together:
- `predict(fen, k)` / `policy(fen)` — policy only (move prediction),
- `evaluate(fen)` — static value,
- `bestMove(fen, opts)` — search-backed pick,
- `analyze(fen, opts)` — search result + policy candidates + static eval in one
  `AnalysisResult`.

## Measurement — `benchmark/`

### `metrics.ts`
`benchmark(positions, engine, opts)` provides the compact legacy summary.
`runReferenceBenchmark()` produces the richer v2 report: per-position rows,
canonical UCI comparison, policy top-k, search multiPV top-k, engine cp-loss,
engine blunder rate, mate correctness, elapsed time, nodes, NPS, PV, abort
reason, skipped rows, engine failures, and per-bucket metrics. `depth: 0`
benchmarks the policy head alone; `depth > 0` uses search.

### `perft.ts`
Move-generation correctness/performance checks. `perft(fen, depth)` counts legal
leaf nodes, and `runPerft()` compares cases against known node counts.

### `speed.ts`
Fixed-position search speed checks. `runSpeedBenchmark()` reports per-position
and aggregate nodes, elapsed time, NPS, best move, abort status, and pass/fail
against an explicit NPS target. `runRustSpeedBenchmark()` delegates the same
gate to the native Rust core when `--core rust` is selected.

## Native Speed Core - `rust/cvs-core`

The native core owns the hot path that cannot reasonably meet release speed
inside the TypeScript object-board implementation. It is a dependency-free Rust
binary with:
- compact 64-square board state and generated move lists,
- legal move generation for castling, en-passant, promotion, pins, and checks,
- copy-make perft, alpha-beta search, capture quiescence, and a Zobrist-keyed
  transposition table,
- TT-backed PV extraction, native MultiPV root-line reporting, and hashfull
  telemetry,
- cooperative UCI `stop`, `go mate`, and clock-budget parsing,
- a rich classical `eval` command plus a speed-safe search leaf evaluator,
- a fixed-position `speed` command that emits the same JSON benchmark shape,
- a JSON `search` command consumed by the TypeScript facade,
- a UCI loop for direct engine-runner smoke tests with basic option handling.

Build it with `npm run rust:build`. Run the release speed gate with
`npm run bench:speed:rust -- --depth 6 --target-nps 1000000`.
Use it from the main CLI with `--core rust`.

### `orchestrator.ts`
Runs mixed benchmark suite jobs from JSON config: reference-analysis/tactical/
positional datasets, perft suites, and gauntlet-result artifacts. The v2 suite
report records a manifest checksum, environment metadata, raw artifact paths,
per-job manifests, and optional release-gate results.

### `manifest.ts`, `stats.ts`, `gauntlet.ts`, `gates.ts`, `tuning.ts`
Benchmark standards support: dataset manifests/checksums, normalized-FEN
dedupe, legal UCI/SAN reference validation, bucket classification, Elo confidence
intervals, SPRT, gauntlet artifact summaries, and configurable correctness /
regression / speed / strength / reporting gates. `tuning.ts` provides a generic
coordinate parameter tuner plus policy/evaluation wrappers.

The release speed gate is **1,000,000 search NPS** from the built UCI engine on
the agreed release suite and hardware. The TypeScript object-board core is a
correctness/reference implementation; the Rust core is the native runtime path
for speed-critical search and strength-runner work.

### `dataset.ts`
JSONL load/save, `buildTrainingPosition` (a (FEN, move) pair → a labelled
`TrainingPosition` with the full feature block), and `buildMoveRows` (expand a
position into per-legal-move ranking rows). This is the bridge from CVS exports /
PGNs / self-play into policy-tuning data.

## Classical Upgrade Seams

| Seam | Today | Classical upgrades |
|------|-------|--------------------|
| `evaluate(chess)` | material/PST/bishop-pair/tempo | pawn structure, king safety, mobility, file/rank/diagonal control, endgame scaling |
| `PolicyWeights` + `scoreFeatures` | linear handcrafted move features | richer motif features, tuned weights, better feature scaling |
| `Searcher` leaf + ordering | value eval + MVV-LVA + policy prior | Zobrist TT, PVS, aspiration windows, killer/history heuristics, LMR, null-move pruning |
| `benchmark/` | reference/perft/suite reports | perft CI, motif-tagged suites, gauntlets, SPRT/Elo gates |

Because each seam is an interface, upgrading a classical component does not
disturb the others.
