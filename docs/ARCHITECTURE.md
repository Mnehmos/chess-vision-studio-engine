# Architecture

The engine is three cooperating heads plus the feature layer they share. Nothing
here is a neural network yet — every component is a transparent, testable
function so the baseline (`CVS-Policy-0`) is fully legible and so each piece is a
clean seam where a learned model can later drop in.

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
- `TrainingPosition` — one labelled supervised example (Phase 2 schema).
- `AnalysisResult`, `CandidateMove`, `MoveTrainingRow`.

## Features

### `features/see.ts` — Static Exchange Evaluation
Given a move `from → to`, simulates the full capture sequence on the destination
square and returns the net centipawn swing for the moving side. It runs on a
mutable `chess.js` clone, re-querying `attackers()` after each capture so x-ray
attackers (a rook behind a rook, a queen behind a bishop) are revealed
naturally, and uses the standard least-valuable-attacker + minimax swap list.
Kings only participate as the final capturer when the square is undefended.

SEE is the backbone of both move quality (policy) and pruning (quiescence).

### `features/moveFeatures.ts`
Turns a verbose `chess.js` move into a `MoveFeatures` vector. The post-move
picture (king-zone attacks, new threats) is read from the move's `after` FEN.

### `features/positionFeatures.ts`
Computes the full `PositionFeatures` block for a FEN: material balance, king
pressure (enemy attacks into the king zone), loose pieces (attacked & undefended),
hanging value (best enemy SEE per piece), center control, and mobility / safe
moves for both sides (the off-turn side via `nullMoveFen`).

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
material. This handcrafted evaluator is the seed a learned value model (Phase 4)
replaces behind the same `evaluate` signature.

## Policy head — `policy/`

### `weights.ts`
`FEATURE_SCALE` normalizes centipawn-scale features (SEE, capture value, PST
delta) and 0/1 indicators into one O(1) range, used identically for scoring and
training. `DEFAULT_POLICY_WEIGHTS` is `CVS-Policy-0`: hand-tuned priors that
reward safe captures/checks/promotions and development while punishing
moving-into-danger.

### `policyEngine.ts`
`rankMoves(fen)` scores every legal move with the linear model and applies a
softmax (with temperature) to produce a probability distribution, sorted highest
first. `topCandidates` slices the top-k. This is the move-prediction head and the
candidate generator for search.

### `train.ts`
`trainPolicy(positions)` learns the weight vector by **softmax (cross-entropy)
ranking**: each position's best/played move is the positive class, the other
legal moves are negatives. Full-batch gradient descent with L2; returns weights
plus a per-epoch loss / top-1-accuracy history. (The bias is left at 0 — softmax
is invariant to a constant logit shift, so it is unidentifiable from ranking.)

## Search head — `search/searchEngine.ts`

A `Searcher` running **negamax alpha-beta** with:
- **iterative deepening** to a depth (or wall-clock) budget,
- a **transposition table** keyed by FEN with exact/lower/upper bounds,
- **MVV-LVA move ordering** (TT move first, then captures by victim/attacker,
  promotions, checks),
- a **capture quiescence search** that stands pat on the static eval, searches
  only non-losing captures/promotions (SEE ≥ 0), and searches all evasions when
  in check,
- distance-scaled **mate scoring** so shorter mates are preferred, surfaced as a
  signed `mate` ply count, and a reconstructed **principal variation**.

It calls the value engine at the leaves — this is the component that turns a
static evaluator into something that looks ahead.

## Composition — `engine.ts`

`CvsEngine` wires the heads together:
- `predict(fen, k)` / `policy(fen)` — policy only (move prediction),
- `evaluate(fen)` — static value,
- `bestMove(fen, opts)` — search-backed pick,
- `analyze(fen, opts)` — search result + policy candidates + static eval in one
  `AnalysisResult`.

## Measurement — `benchmark/`

### `metrics.ts`
`benchmark(positions, engine, opts)` compares engine picks against a dataset's
reference move and reports **top-1 match**, **top-k overlap**, **average
centipawn loss**, **blunder rate**, and **mate-detection rate** — the roadmap's
measurable ladder. `depth: 0` benchmarks the policy head alone; `depth > 0` uses
search.

### `dataset.ts`
JSONL load/save, `buildTrainingPosition` (a (FEN, move) pair → a labelled
`TrainingPosition` with the full feature block), and `buildMoveRows` (expand a
position into per-legal-move ranking rows). This is the bridge from CVS exports /
PGNs / self-play into trainable data.

## Where learned models drop in

| Seam | Today | Later |
|------|-------|-------|
| `evaluate(chess)` | handcrafted material/PST | learned value net (FEN → cp / WDL) |
| `PolicyWeights` + `scoreFeatures` | linear over handcrafted features | larger learned ranker over the same features (or raw board tensor) |
| `Searcher` leaf + ordering | value eval + MVV-LVA | policy-prior-guided ordering / MCTS |

Because each seam is an interface, upgrading a head does not disturb the others.
