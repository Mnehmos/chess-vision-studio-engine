# Rust Runtime Parity Specs

The five remaining items from the *Remaining Native Runtime Work* section of the
[engine checklist](NON_NNUE_ENGINE_CHECKLIST.md), each given a **shape** as
required by the [Development SOP](DEVELOPMENT_SOP.md) §3: *do not build a feature
until the feature has a shape.*

The TypeScript core (`src/`) is the **behavioral oracle**. Each spec names the TS
symbol that defines correct behavior; the Rust core
(`rust/cvs-core/src/main.rs`, ~2.8k lines, single file) must agree with it. The
[`src/rust/core.ts`](../src/rust/core.ts) JSON bridge is the contract between the
two cores.

**Status legend:** ⬜ not started · 🟨 in progress · ✅ done (move the box in the
checklist and record numbers in *Latest Rust Gate Run* when you land one).

### Universal acceptance rules (apply to every spec)

Every item below inherits these, from the SOP:

1. `npm run bench:perft` unchanged — move generation legality is never affected.
2. Native search stays **≥ 1,000,000 NPS** on the depth-6 suite; record
   before/after NPS.
3. Strength-affecting changes need a **neutral-or-positive SPRT** vs the prior
   build (§5 of the SOP).
4. Any constant shared with TS (piece values, PST, policy weights, SEE values)
   gets a **parity test**, not a hand-copied second source of truth.
5. Checklist + this file + *Latest Rust Gate Run* updated before commit.

### Shared TS references

| Concern | TS source of truth |
|---|---|
| Static exchange evaluation | [`src/features/see.ts`](../src/features/see.ts) `see(fen, from, to)` |
| Per-move features (14 keys) | [`src/types.ts`](../src/types.ts) `MoveFeatures` / `MOVE_FEATURE_KEYS` |
| Policy weights & scaling | [`src/policy/weights.ts`](../src/policy/weights.ts) `FEATURE_SCALE`, `DEFAULT_POLICY_WEIGHTS`, `scoreFeatures` |
| Policy ranker | [`src/policy/policyEngine.ts`](../src/policy/policyEngine.ts) `rankMoves` |
| Classical eval terms | [`src/value/classicalTerms.ts`](../src/value/classicalTerms.ts) |
| Incremental eval boundary | [`src/value/incremental.ts`](../src/value/incremental.ts) |
| UCI session behavior | [`src/uci.ts`](../src/uci.ts) `UciSession` |
| Motif taxonomy & detectors | [`src/features/motifs.ts`](../src/features/motifs.ts) |

### Recommended sequencing

SEE (Spec 2) is a dependency of policy ordering (Spec 3, whose `see` feature
needs it) and improves quiescence on its own, so do it first. Incremental eval
(Spec 4) is what *affords* richer leaf evaluation and motif promotion under the
NPS floor, so it precedes motif parity (Spec 5). Ponder (Spec 1) is independent
and low strength-risk but needed for real match play. Suggested order:
**2 → 4 → 3 → 5 → 1**.

---

## Spec 1: Ponder lifecycle and complete option semantics

**Status:** ⬜ not started.

**Problem.** The Rust UCI loop does not really ponder. `ponderhit` is a no-op
(`main.rs:2010`), `go ponder` is treated the same as `go infinite`
(`spawn_uci_search`, `main.rs:2023`), no `Ponder` option is advertised
(`cmd_uci`, `main.rs:1985`), and `bestmove` never carries a ponder move
(`main.rs:2056`). There is also no persistent transposition table across moves —
a TT is built per `go` inside `search_with_stop`, so a pondering search cannot
warm the table the real search reuses.

**Reference.** [`src/uci.ts`](../src/uci.ts) `UciSession` — `GoOptions.ponder`,
`GoOptions.infinite`, and the stop/ponder handling the TS side already models
(the *Time And UCI* checklist section is complete on the TS side).

**Target design** (`rust/cvs-core/src/main.rs`):
- Advertise `option name Ponder type check default false` in `cmd_uci`.
- Emit the ponder move: `bestmove <best> ponder <pv[1]>` when a second PV move
  exists (extend the `println!("bestmove …")` in `spawn_uci_search`).
- `go ... ponder`: search the current position with no time cutoff (like
  `infinite`) until `ponderhit` or `stop`. It must not self-terminate on a clock
  budget while pondering.
- `ponderhit`: convert the in-flight pondering search into a normally-timed
  search — start the clock/`max_time_ms` from the hit (or from the original
  `go` budget) so the engine returns `bestmove` on time. Requires threading a
  shared, updatable deadline into the running search thread rather than the
  fixed `max_time_ms` captured at spawn.
- Complete option semantics: every advertised option round-trips through
  `setoption` (`apply_setoption`, `main.rs:2106`); `Clear Hash` button honored;
  unknown options ignored gracefully; `Threads` accepted (single-thread stays,
  value clamped) rather than silently dropped.
- Consider (and document the decision either way) a **persistent TT** across
  `go` calls so pondering actually pays off; if kept per-search, note it as a
  known limitation.

**Acceptance criteria.**
- ⬜ `uci` advertises `Ponder`; `setoption name Ponder value true` round-trips.
- ⬜ On a position with a ≥2-ply PV, `bestmove` includes a legal `ponder` move.
- ⬜ A scripted transcript — `go ... ponder` → `ponderhit` → engine returns
  `bestmove` within the timed budget — passes as a Rust `#[test]` or a TS
  UCI-transcript test driving the built binary.
- ⬜ `stop` during pondering returns `bestmove` from completed work.
- ⬜ Universal rules (perft, NPS floor — ponder must not touch the fixed-depth
  speed path).

**Verification.** Rust UCI smoke transcript (extend the one in the checklist's
gate-run notes) + `cargo test`; NPS floor gate. Strength: a ponder-on gauntlet
must not lose on time vs ponder-off.

**Risks.** Deadline mutation from another thread (data race) — use the existing
`Arc<AtomicBool>` stop pattern plus an `Arc<AtomicU64>` deadline. Emitting an
illegal ponder move (validate it is `pv[1]` from a legal PV). Over-scoping into
multi-thread search — keep single-thread.

---

## Spec 2: SEE pruning with a real static-exchange evaluator

**Status:** ⬜ not started.

**Problem.** The Rust core has no SEE. Move ordering uses MVV-LVA only
(`move_score`, `main.rs:1772`), `is_tactical_move` is "capture or promotion"
(`main.rs:1796`), and quiescence keeps *all* captures/promotions
(`retain_tactical_moves`, `main.rs:1701`). Clearly-losing captures (e.g. a queen
takes a defended pawn) are ordered high and expanded in quiescence.

**Reference.** [`src/features/see.ts`](../src/features/see.ts) `see(fen, from,
to)` — full swap-list SEE: re-queries attackers after each capture so x-ray
attackers are revealed, uses least-valuable-attacker + minimax, king only as the
final capturer on an undefended square. Test vectors in
[`test/see.test.ts`](../test/see.test.ts) (5 cases).

**Target design** (`rust/cvs-core/src/main.rs`):
- Add `fn see(board: &Board, mv: Move) -> i32` returning the net centipawn swing
  for the side to move, built on a least-valuable-attacker enumerator over the
  compact board (generalize `is_attacked`/`ray_attacked`,
  `main.rs:717`/`760`, into "least valuable attacker of `sq` for `side`", with
  x-ray re-query after each removal). Handle en-passant, promotions, and the
  king-as-final-capturer rule exactly as the TS reference does.
- Use it in three places:
  1. **Ordering** — winning/equal captures (`see ≥ 0`) sort above quiets;
     losing captures (`see < 0`) sort below quiets, inside `move_score`.
  2. **Quiescence** — drop `see < 0` captures in `retain_tactical_moves` /
     `quiesce` (`main.rs:1599`) (delta/SEE pruning), never while in check.
  3. **Shallow search** — SEE-prune clearly-losing tactical moves and gate LMR /
     futility on SEE, matching the TS *"static exchange pruning for clearly
     losing tactical moves"* checklist item.

**Acceptance criteria.**
- ⬜ Rust `#[test]` port of the 5 `see.ts` vectors returns identical swings.
- ⬜ Quiescence no longer expands `see < 0` captures (assert node-count drop on a
     tactical FEN, or a targeted `quiesce` unit test).
- ⬜ Tactical suite solve rate (SEE-trap / hanging-piece buckets) does not
     regress and ideally improves.
- ⬜ Universal rules (perft unchanged; NPS floor held — SEE in ordering is a perf
     risk, so measure and, if needed, compute SEE lazily / sign-only).

**Verification.** `cargo test`; tactical bucket via the benchmark suite;
`npm run bench:speed:rust:dist -- --depth 6 --target-nps 1000000`. Strength:
SPRT vs the pre-SEE build (expected non-negative).

**Risks.** A subtly wrong LVA order silently weakens pruning without failing
perft — the ported test vectors are the guard. SEE cost in the ordering hot path
can sink NPS; keep it to captures and consider a cheap sign-only fast path.

---

## Spec 3: Policy-ordering parity

**Status:** ⬜ not started.

**Problem.** The TS search orders moves with policy logits
(`policyOrdering` in [`src/uci.ts`](../src/uci.ts); `DEFAULT_POLICY_WEIGHTS` over
14 `MoveFeatures`). The Rust core has no policy features and no policy-ordering
option — it orders by MVV-LVA + heuristics only.

**Reference.**
- Feature keys: [`src/types.ts`](../src/types.ts) `MOVE_FEATURE_KEYS` — the 14
  signals: `isCapture, isCheck, isPromotion, isCastle, isEnPassant, see,
  captureValue, escapesAttack, movesIntoDanger, pstDelta, develops,
  attacksKingZone, movesToCenter, createsThreat`.
- Scaling/weights: [`src/policy/weights.ts`](../src/policy/weights.ts)
  `FEATURE_SCALE`, `DEFAULT_POLICY_WEIGHTS`, `scoreFeatures`.
- Ranker: [`src/policy/policyEngine.ts`](../src/policy/policyEngine.ts)
  `rankMoves`.

**Target design** (`rust/cvs-core/src/main.rs`):
- Compute the 14 `MoveFeatures` in Rust for a move. `see` reuses **Spec 2**;
  `pstDelta` reuses `pst_mg`/`pst_eg` (`main.rs:2388`); the 0/1 indicators come
  from move flags and cheap board queries.
- Port `FEATURE_SCALE` and `DEFAULT_POLICY_WEIGHTS` as Rust constants and add a
  **parity test** asserting the Rust constants equal the TS values (single
  source of truth — do not let the two drift silently).
- Add a policy logit term to `move_score` when policy ordering is enabled, gated
  by UCI options mirroring `UciSessionOptions`: `Policy Ordering` (check) and
  `Policy Ordering Weight` (spin). Match the TS **scope** — TS applies policy
  ordering at the root / full-width ordering, not at every leaf — to protect the
  NPS floor.

**Acceptance criteria.**
- ⬜ Parity test: Rust `FEATURE_SCALE` / `DEFAULT_POLICY_WEIGHTS` equal the TS
     constants exactly.
- ⬜ On a fixed FEN set, Rust policy-on ordering reproduces the TS `rankMoves`
     top move at an agreed rate (target: exact top-1 match on the set).
- ⬜ `Policy Ordering` / `Policy Ordering Weight` round-trip via `setoption`.
- ⬜ Universal rules — NPS floor held (feature computation is the perf risk; keep
     policy ordering shallow/root-scoped).

**Verification.** `cargo test` (parity + ordering); a small TS↔Rust ordering
comparison harness on shared FENs; speed gate. Strength: SPRT vs policy-off Rust.

**Risks.** Computing 14 features per move at every node destroys NPS — bound the
scope to where TS uses it. Weight drift between cores — the parity test is
mandatory. Depends on **Spec 2** for the `see` feature.

---

## Spec 4: Incremental evaluation and release-speed rich-eval leaf

**Status:** ⬜ not started.

**Problem.** Rust leaf eval uses a deliberately thin subset
(`evaluate_search_white`, `main.rs:966`); the rich classical terms
(`classical_terms` and friends, `main.rs:794`+) run only for the `eval` command
because running them at every leaf would breach the NPS floor. TS exposes the
incremental boundary in [`src/value/incremental.ts`](../src/value/incremental.ts)
(recompute-today, optimize-behind-the-same-API).

**Target design** (`rust/cvs-core/src/main.rs`):
- Maintain running evaluation state incrementally in `make_move`/`null_move`
  (`main.rs:612`/`689`): tapered material + PST delta, phase units, and a
  pawn-structure signature, updated on each make rather than recomputed.
- Introduce a **richness knob** so more classical terms run at leaves while
  holding ≥ 1,000,000 NPS — e.g. an incrementally-maintained subset plus a
  measured default, and/or an off-by-default switch for the full set. The knob's
  default must clear the speed floor.
- Keep `classical_terms` as the from-scratch oracle for the `eval` command and
  for the parity test below.

**Acceptance criteria.**
- ⬜ **Incremental == from-scratch** parity test: over random legal move
     sequences, the incrementally-updated white score equals a full recompute at
     every step (mirrors the TS make/undo round-trip discipline). This is the
     single most important guard — silent eval corruption otherwise.
- ⬜ Universal rules — NPS floor held **with the richer default leaf**; record
     before/after NPS in *Latest Rust Gate Run*.
- ⬜ Strength: SPRT vs the thin-leaf build (a richer, correct leaf is expected to
     gain Elo).

**Verification.** `cargo test` (incremental parity); speed gate with the new
default; SPRT. 

**Risks.** Incremental update bugs do not fail perft and do not crash — they
quietly corrupt evaluation. The from-scratch parity test is non-negotiable.
Dropping below 1M NPS is a hard fail; if the richer leaf costs too much, shrink
the default subset rather than lowering the floor.

---

## Spec 5: Motif detector parity (where motifs feed a consumer)

**Status:** ⬜ not started.

**Problem.** [`src/features/motifs.ts`](../src/features/motifs.ts) carries the
full normalized taxonomy (~200 labels) and deterministic detectors; the Rust
core has none. **Scope is deliberately narrow:** parity is required only for
motifs that actually feed a runtime consumer — evaluation, policy, explanations,
or benchmark buckets — *not* the whole taxonomy.

**Target design.**
1. **Audit first.** Enumerate which motifs currently influence a runtime path in
   TS (an eval term, a policy feature, or a benchmark **bucket** in
   `src/benchmark/`), versus those that are explanation-only labels. Record the
   audit in this spec before porting anything.
2. Port **only** the consumer-facing motifs into Rust as deterministic detectors
   with outputs identical to TS on the motif-tagged FEN set.
3. Surface them where consumed — extend the Rust `eval`/`search` JSON
   (`print_search_json`, `main.rs:2273`; `src/rust/core.ts` mapping) so the
   TS/benchmark layer reads the same motif flags from either core. Explanation-
   only labels stay in the TS reference; the Rust core emits the data the TS
   layer annotates.

**Acceptance criteria.**
- ⬜ Audit table (consumer-facing vs explanation-only) recorded in this spec.
- ⬜ For each consumer-facing motif, Rust detector output matches TS on the
     tagged bucket.
- ⬜ Per-bucket benchmark parity between `core: "rust"` and the TS core on the
     motif-tagged suite.
- ⬜ Universal rules — no NPS regression: motif detection stays out of the search
     hot path unless a motif is a promoted eval term carrying its own budget
     (then it also obeys Spec 4).

**Verification.** `cargo test` (detector parity on tagged FENs); benchmark suite
per-bucket comparison across cores; speed gate.

**Risks.** Scope creep — porting all ~200 taxonomy labels is out of scope and
would be wasted work; port only what a consumer reads. Promoting a motif into
eval without a speed budget breaches the floor (see Spec 4).

---

## Change log for this file

Update the status boxes and *Latest Rust Gate Run* in the
[checklist](NON_NNUE_ENGINE_CHECKLIST.md) as items move. The repo is the memory:
if the next agent needs to know it, it lives here, not in a chat log.
