# Classical Engine Checklist

This checklist is for the classical Chess Vision Studio engine: native legal
move generation, alpha-beta search, handcrafted evaluation, and measured tuning.
This repository will not use NNUE, neural policy/value networks, or MCTS; that
work belongs in the separate neural engine.

## References

- Claude Shannon, "Programming a Computer for Playing Chess" (1950): minimax,
  static evaluation, and selective search framing.
  <https://www.computerhistory.org/chess/doc-431614f453dde/>
- Donald Knuth and Ronald Moore, "An Analysis of Alpha-Beta Pruning" (1975):
  alpha-beta correctness and ordering sensitivity.
  <https://philpapers.org/rec/KNUAAO-2>
- Richard Korf, "Depth-First Iterative-Deepening: An Optimal Admissible Tree
  Search" (1985): iterative deepening as a practical depth-first search schedule.
  <https://academiccommons.columbia.edu/doi/10.7916/D8HQ46X1>
- Greenblatt, Eastlake, and Crocker, "The Greenblatt Chess Program" (1967):
  practical chess-program heuristics, quiescence, and transposition-table lineage.
  <https://dl.acm.org/doi/pdf/10.1145/1465611.1465715>
- Chess Tempo positional motif taxonomy: examples and definitions for positional
  tags used in problem annotation.
  <https://chesstempo.com/positional-motifs>
- Chess Tempo tactical motif taxonomy: examples and definitions for tactical
  tags used in problem annotation.
  <https://chesstempo.com/tactical-motifs>
- Chessprogramming wiki, "Engine Testing": perft for move-generation
  correctness, position tests, and engine-vs-engine testing.
  <https://www.chessprogramming.org/Engine_Testing>
- Chessprogramming wiki, "Perft": debugging move generation, make move, and
  unmake move by comparing known node counts.
  <https://www.chessprogramming.org/Perft>
- Stockfish Fishtest mathematics: statistical testing models used for engine
  evaluation and parameter tuning.
  <https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html>
- Cute Chess: engine GUI and `cutechess-cli` tooling for automated engine
  matches.
  <https://cutechess.com/>
- CCRL testing conditions: example of standardized hardware, time controls,
  opening books, and rating-list discipline.
  <https://computerchess.org.uk/404/about.html>

## Current Status

The TypeScript implementation is the correctness/reference engine and remains
useful for policy, evaluation, motif, UCI, and benchmark behavior. The Rust core
is the intended release runtime for speed-sensitive play. The sections below
keep the completed project/reference capability checklist, while **Rust Runtime
Parity Checklist** tracks what is actually implemented in the native core today.

- [x] Native chess backend: FEN, legal moves, SAN/LAN, make/undo, attackers,
  castling, en-passant, promotion, terminal checks.
- [x] UCI loop: handshake, readiness, position, depth/time `go`, options, quit.
- [x] Static evaluator: material, PST, phase taper, bishop pair, tempo.
- [x] Policy head: linear handcrafted move features and tunable weights.
- [x] Search: iterative-deepening negamax alpha-beta, TT, quiescence, mate scores.
- [x] Policy-aware search ordering: policy logits now influence full-width move
  ordering while tactical/value search still decides the move.
- [x] Benchmark scaffold: top-1/top-k, centipawn loss, blunder, mate detection.
  This is not yet a release-quality strength benchmark.
- [x] Benchmark orchestrator: reference benchmark reports, perft reports, and
  mixed suite JSON runs.

## Rust Runtime Parity Checklist

These items are the release-readiness checklist for the classical non-NNUE Rust
core. A checked item means the native runtime path implements it directly, not
only through the TypeScript reference engine.

### Implemented Native Runtime Items

- [x] Rust release binary builds from `rust/cvs-core`.
- [x] Rust board representation parses FEN and generates legal moves.
- [x] Rust make/unmake path supports castling, en-passant, promotions, checks,
  and terminal positions.
- [x] Rust perft command supports fixed-depth correctness and speed runs.
- [x] Rust perft tests cover start position, Kiwipete, castling, en-passant,
  promotion, and illegal castling-through-check cases.
- [x] Rust alpha-beta search supports fixed-depth iterative deepening.
- [x] Rust quiescence search handles captures/promotions and all check evasions.
- [x] Rust search supports node limits and root `searchmoves` filtering.
- [x] Rust search emits JSON usable by the TypeScript engine facade.
- [x] TypeScript `CvsEngine` can select `searchCore: "rust"` per instance or
  per call.
- [x] Main CLI can analyze and self-play with `--core rust`.
- [x] Benchmark speed command can run the Rust core with `--core rust`.
- [x] Rust UCI path supports handshake, readiness, `position`, `go depth`,
  `go movetime`, `go nodes`, `go searchmoves`, and `quit`.
- [x] Rust search emits basic `info` telemetry: depth, seldepth, score, nodes,
  time, nps, hashfull, and PV text.
- [x] Rust transposition table uses deterministic Zobrist keys with exact,
  lower, and upper bounds.
- [x] Rust TT move ordering searches the stored best move before tactical
  ordering.
- [x] Rust PV reconstruction follows legal TT moves from the root instead of
  returning only the first move.
- [x] Rust MultiPV search reports multiple sorted root lines in JSON and UCI
  output.
- [x] TypeScript Rust facade maps native MultiPV lines into benchmark-compatible
  `SearchPvLine` results.
- [x] Rust UCI reports `Hash`, `Threads`, `Clear Hash`, and `Default Depth`
  options, and parses `setoption` for `Hash`, `MultiPV`, and `Default Depth`.
- [x] Rust UCI parses `Move Overhead`, `go mate`, `wtime/btime`,
  `winc/binc`, and `movestogo`, and allocates a bounded clock budget.
- [x] Rust UCI runs search on a background thread and supports cooperative
  `stop` with `bestmove` output from the latest completed work.
- [x] Rust search includes aspiration windows, PVS, killer/history/countermove
  ordering, check and recapture extensions, LMR, null-move pruning, and shallow
  futility/reverse-futility pruning.
- [x] Rust rich classical eval command covers tapered PST, bishop pair, pawn
  structure, king safety, mobility, rook/queen file features, minor-piece
  quality, space/center, and opposite-bishop scaling.
- [x] Rust search leaf eval uses a speed-safe classical subset so release search
  still clears the native NPS floor.
- [x] Benchmark suite reference jobs can select `core: "rust"` for tactical,
  positional, and reference-analysis runs while preserving suite artifacts.
- [x] CI gates Rust tests, Rust release build, and the Rust speed floor.
- [x] Cute Chess release configuration exists for the Rust UCI binary with fixed
  engine options, openings, time control, concurrency, adjudication, and PGN/log
  artifact paths.
- [x] Native speed gate currently clears the 1,000,000 NPS floor on the fixed
  depth-6 benchmark suite.

### Remaining Native Runtime Work

- [ ] Full Rust ponder lifecycle and complete option semantics beyond the
  currently accepted UCI options.
- [ ] Rust SEE pruning with a real static-exchange evaluator, not just tactical
  ordering and quiescence filtering.
- [ ] Rust policy-ordering parity with the handcrafted policy feature set.
- [ ] Rust incremental evaluation hooks and a release-speed path for using more
  of the rich eval terms at search leaves without falling below 1,000,000 NPS.
- [ ] Rust motif detector parity where motifs are used by evaluation, policy,
  explanations, or benchmark buckets.

### Latest Rust Gate Run

Run date: 2026-07-01.

- [x] `npm run rust:test`: 14 Rust tests passed.
- [x] `npm run typecheck`: TypeScript typecheck passed.
- [x] `npm test`: 12 test files and 69 tests passed.
- [x] `npm run build`: TypeScript distribution build passed.
- [x] `npm run rust:build`: Rust release build passed.
- [x] `npm run bench:speed:rust:dist -- --depth 6 --target-nps 1000000`:
  passed with 555,217 total nodes in 401 ms, or 1,384,581 NPS.
- [x] `node dist/bin/cvs-engine.js analyze ... --core rust --depth 4 --k 2`:
  compiled CLI used the Rust backend, found `e4d5`, and emitted a multi-move PV
  in the hanging-queen smoke position.
- [x] `node bin/run-rust-core.cjs eval ...`: emitted rich classical eval JSON.
- [x] `node bin/run-rust-core.cjs search ... --depth 2 --multipv 3`: emitted
  three sorted native `multiPv` root lines.
- [x] Rust UCI smoke: `uci`, `setoption name Hash value 32`,
  `setoption name MultiPV value 2`, `isready`, `position startpos`,
  `go infinite searchmoves e2e4 d2d4 g1f3`, delayed `stop`, and `quit`
  returned `bestmove g1f3` with `info ... multipv` lines.

## Correctness Foundation

- [x] Add perft counts for start position, castling, en-passant, promotion,
  pins/checks, and illegal castling-through-check positions.
- [x] Add make/undo round-trip tests over random legal move sequences.
- [x] Add FEN normalization tests for halfmove/fullmove counters, castling rights,
  and en-passant visibility.
- [x] Add UCI protocol transcript tests for common GUI sequences.
- [x] Add mate/stalemate/insufficient-material edge cases.

## Search

- [x] Negamax alpha-beta.
- [x] Iterative deepening.
- [x] Quiescence search for captures/promotions and all evasions in check.
- [x] Transposition table with exact/lower/upper bounds.
- [x] Root/result PV reconstruction.
- [x] Policy-aware full-width move ordering.
- [x] Zobrist hash keys instead of full-FEN TT keys.
- [x] Aspiration windows around the previous iteration score.
- [x] Principal variation search.
- [x] Killer-move and history heuristics.
- [x] Countermove or continuation-history ordering.
- [x] Check extensions and recapture extensions.
- [x] Late move reductions with tactical exclusions.
- [x] Null-move pruning with zugzwang guards.
- [x] Futility/reverse-futility pruning at shallow depths.
- [x] Static exchange pruning for clearly losing tactical moves.

## Evaluation

- [x] Material and tapered PST.
- [x] Bishop pair and tempo.
- [x] Pawn structure: doubled, isolated, backward, passed, connected passers.
- [x] King safety: pawn shield, open files, attack units, safe checks.
- [x] Mobility by piece type with phase weighting.
- [x] Rook/queen file features: open/semi-open files, seventh rank.
- [x] Minor-piece features: outposts, trapped bishops, bishop color complex.
- [x] Space and center control beyond current coarse feature counts.
- [x] Endgame-specific scaling: opposite bishops, rook pawns, bare-material draws.
- [x] Incremental evaluation hooks once move generation stabilizes.

## Motif Capability Coverage

Treat these as capability coverage, not all as direct centipawn terms. The first
implementation target is deterministic detection and explanation labels. After a
motif has test coverage and benchmark signal, promote it into evaluation, policy
features, move ordering, search extensions, or tuning labels.

Implementation note: `features/motifs.ts` contains the complete normalized
taxonomy and conservative deterministic detectors. Some named mate and tactical
motif labels are taxonomy-supported before they are promoted into highly specific
pattern recognizers.

### Positional Motifs

- [x] Pawn structure detectors: backwards pawn, connected pawns, doubled pawns,
  isolated pawn, outside passed pawn, passed pawn, protected passed pawn, pawn
  blockade, pawn break, pawn grab, pawn majority, pawn phalanx, pawn storm,
  minority attack.
- [x] Bishop and minor-piece quality: bad bishop, good bishop, bishop pair,
  opposite-colour bishops, same-colour bishops, knight outpost.
- [x] Files/ranks/lines: closed file, open file, semi-open file, file control,
  rank control, diagonal control, center control, opening centre.
- [x] Rook/queen coordination: connected rooks, doubled rooks, Alekhine's gun,
  rook lift, rook on 7th rank, vertical battery, diagonal battery,
  queen+knight coordination.
- [x] King and safety themes: king safety, centralised king, king march, luft,
  opposite-side castling.
- [x] Activity and space: improve piece activity, limit piece activity, piece
  activity, piece centralisation, piece coordination, domination, penetration,
  space, initiative.
- [x] Trade and defence decisions: avoid trade, favourable trade, defence,
  overprotection, prophylaxis.
- [x] Positional sacrifices: exchange, pawn, piece, queen, rook.

### Checkmate Motifs

- [x] Named mate patterns: Anastasia's mate, Arabian mate, Blackburne's mate,
  Damiano's bishop mate, Damiano's mate, Greco's mate, Hook mate, Lolli's mate,
  Morphy's mate, Opera mate, Pillsbury's mate, Boden's mate, Vukovic mate.
- [x] Geometry and confinement mates: Balestra mate, edge mate, back-rank mate,
  edge pin mate, queen cutoff mate, side file mate, smothered mate, suffocation
  mate, epaulette mate, escalator mate, kill box mate, lawnmower mate, monorail
  mate, railroad mate, seizing-a-square mate, swallow's tail mate, dovetail mate,
  dovetail mate - bishop, triangle mate, walking-the-plank mate, x-ray mate.
- [x] Tactical mate mechanisms: discovered mate, counter-check checkmate,
  double checkmate, pawn checkmates, pawn mate, promotion mate, queen-and-knight
  mate, threading-the-needle mate.

### Tactical And Non-Mate Motifs

- [x] Promotion themes: advanced pawn, non-promotion advanced pawn, promotion,
  underpromotion, promotion threat, underpromotion threat.
- [x] Drawing and defensive themes: avoiding perpetual, avoiding stalemate,
  achieving perpetual, avoiding mate, defensive move, defensive interposition,
  recapture, reprotection.
- [x] Clearance and blocking: blocking, clearance, diagonal clearance, file
  clearance, rank clearance, square clearance.
- [x] Forcing mechanisms: attraction, coercion, controlling escape square,
  counter check, counting, multi-square counting, gain of tempo, zwischenzug.
- [x] Discovery and exposed-king motifs: discovery, discovered attack,
  discovered check, discoverer checks, double check, discovered defense,
  exposed king.
- [x] Sequence and reloader motifs: aiming sequence, appended attack, desperado,
  hit and run, hit and run - capture defender, hit and run - discovery,
  jailbreak, pendulum, reload, rethreaten.
- [x] Tactical targets: under-protected piece, capturing attacker, hanging piece,
  hook and ladder, mate threat, weak back rank, trapped piece, win the exchange.
- [x] Move-type labels: backwards move, en passant, long lateral move, tactical
  castling, quiet move.
- [x] Multiple-attack motifs: multiple attack, double attack, fork, family fork,
  royal fork, tag team.
- [x] Constraint/problem-shape labels: needs different opponent move, needs more
  moves, zugzwang.
- [x] Line tactics: pin, absolute pin, cross-pin, relative pin, mate pin, skewer,
  relative skewer, skewer of queen, skewer of rook, skewer of king, x-ray,
  x-ray attack, x-ray defense.
- [x] Defender removal and interference: removing the guard, capturing defender,
  distraction, attacking the defender, luring the defender, interference,
  overloading.
- [x] Sacrifice labels: sacrifice, demolition sacrifice, Greek gift, exchange
  sacrifice, passive sacrifice, pawn sacrifice, unsound sacrifice, simplification.
- [x] Special tactical motifs: unpinning, windmill, windmill - discoveries,
  windmill - knight fork.

## Time And UCI

- [x] Depth and basic clock-budgeted `go`.
- [x] Move overhead option.
- [x] Policy-ordering UCI options.
- [x] Proper stop/ponder handling with interruptible search.
- [x] Nodes, movetime, mate, and searchmoves support.
- [x] More complete `info` lines: time, nps, hashfull, seldepth, multipv.
- [x] Time allocation by phase, increment, moves-to-go, and score volatility.

## Benchmarking Standards Audit

### Current Benchmark Gaps

- [x] Fix `avgCpLoss`: current code sums dataset `cpLoss`; it does not compute
  the centipawn loss of the engine's chosen move.
- [x] Fix `blunderRate`: current code counts positions whose dataset `cpLoss`
  exceeds the threshold; it does not count engine-caused blunders.
- [x] Fix top-1 move equality: compare canonical UCI moves, not only normalized
  SAN, so references stored as UCI and engine moves stored as SAN do not
  mismatch.
- [x] Add separate search top-k/multiPV metrics; `topKMatch` is policy top-k
  and `searchTopKMatch` is search multiPV top-k.
- [x] Make mate detection stricter: require correct mating move/side/distance
  where the dataset provides it, not just "engine reports some mate".
- [x] Add denominators for every metric: positions attempted, illegal/invalid
  rows skipped, reference rows with cp data, reference rows with mate data, and
  engine failures/timeouts.
- [x] Capture runtime telemetry: elapsed milliseconds, nodes, NPS, depth reached,
  abort/time-budget status, and PV.
- [x] Add terminal-position counts and timeout/abort reason fields.

### Required Benchmark Types

- [x] Correctness benchmarks: perft suites for start position, castling,
  en-passant, promotion, checks, pins, and illegal castling-through-check.
- [x] Move-generator performance: perft nodes/sec by depth and position class,
  reported separately from playing strength.
- [x] Fixed-position tactical suites: solve rate by depth/time, mate solve rate,
  SEE trap avoidance, hanging-piece wins, quiet defensive moves, and motif tags.
- [x] Positional/evaluation suites: STS-style positional positions, motif-tagged
  ChessTempo-style positions, and handcrafted eval regression positions.
- [x] Reference-analysis suites: Stockfish or other reference engine multiPV
  rows with engine/version, depth, nodes, hash, tablebase setting, cp/mate score,
  and score perspective.
- [x] Engine-vs-engine strength tests: UCI matches against prior versions and
  fixed external baselines under controlled openings and time controls.
- [x] Long-run release gauntlets: multiple opponents, mirrored openings, fixed
  concurrency, fixed adjudication, PGN retention, and rating confidence intervals.

Gauntlet jobs are artifact-driven: an external UCI match runner can produce PGN,
UCI-log, and result JSON artifacts, and the benchmark suite validates/statistically
gates those artifacts with fixed engine/opponent settings.

### Statistical Standards

- [x] Use SPRT or an equivalent sequential test for code changes expected to
  affect playing strength.
- [x] Report Elo estimate plus confidence interval for gauntlets; do not promote
  patches from raw win percentage alone.
- [x] Use paired/mirrored openings to reduce opening-book noise.
- [x] Keep fixed engine settings during A/B tests: hash, threads, tablebases,
  contempt/draw settings, policy-ordering settings, and time control.
- [x] Record hardware and environment: CPU, OS, Node version, engine git SHA,
  build mode, benchmark suite version, and random/opening seed.
- [x] Preserve raw artifacts: benchmark JSON, PGNs, UCI logs for failures, and
  exact dataset manifests.

### Dataset Standards

- [x] Version every benchmark suite with a manifest and checksum.
- [x] Deduplicate positions by normalized FEN or hash.
- [x] Split fit, tuning, validation, and release-test suites so policy/value
  fitting cannot overfit the benchmark.
- [x] Store legal reference moves in UCI and SAN, with UCI as the comparison key.
- [x] Store score perspective explicitly: side-to-move, White, or reference
  engine convention.
- [x] Store motif tags as labels, not as free-form text, so coverage can be
  measured by tag.
- [x] Keep terminal, tablebase, opening, middlegame, and endgame positions in
  separate buckets for per-bucket reporting.

### Release Gates

- [x] Correctness gate: perft suite must pass before any benchmark result is
  trusted.
- [x] Regression gate: tactical/positional fixed suites must not regress beyond
  agreed tolerance.
- [x] Speed gate: NPS and nodes-to-solution must not regress beyond agreed
  tolerance unless Elo improves.
- [x] Release speed floor: built UCI search must reach at least 1,000,000 NPS
  on the agreed release hardware/suite before Cute Chess strength evaluation is
  considered meaningful. Current TypeScript object-board search is below this
  floor and should be treated as a correctness/reference implementation.
- [x] Native speed core: Rust release binary for hot move generation/search with
  fixed-position `bench speed --core rust` support and minimal UCI smoke path.
- [x] Native search backend: Rust `search` JSON command is callable through
  `CvsEngine({ searchCore: "rust" })` and `cvs-engine analyze --core rust`.
- [x] Native quiescence and node/searchmove limits for the Rust backend.
- [x] Native test coverage for startpos/Kiwipete perft, targeted rules, and a
  hanging-queen search smoke case.
- [x] Native speed gate currently clears the 1,000,000 NPS floor on the fixed
  depth-6 benchmark suite.
- [x] Strength gate: self-play or baseline gauntlet must pass SPRT/Elo criteria.
- [x] Reporting gate: every benchmark run must emit a reproducible manifest and
  raw artifact path.

## Measurement

- [x] Unit tests for policy, value, search, UCI, native chess backend.
- [x] Benchmark report shape.
- [x] Reference benchmark v2 with engine cp-loss, engine blunder rate, canonical
  UCI comparison, runtime telemetry, and raw per-position rows.
- [x] Perft benchmark runner.
- [x] Search speed benchmark runner with explicit NPS target/pass-fail report.
- [x] Benchmark suite orchestrator.
- [x] Perft suite in CI.
- [x] Tactical test suite: mates, hanging pieces, SEE traps, quiet defenses.
- [x] STS-style positional suite support for handcrafted eval regressions.
- [x] Self-play/engine-vs-engine gauntlet artifact reporting against fixed versions.
- [x] Node-count and NPS regression tracking.
- [x] Parameter tuning loop for evaluation and policy weights.
- [x] Per-bucket benchmark metrics by phase, motif tag, terminal/tablebase class,
  and source.
