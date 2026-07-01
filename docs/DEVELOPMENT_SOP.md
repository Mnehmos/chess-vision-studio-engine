# Development SOP

Standard operating procedure for all work in this repository, human or agent.
It adapts **[The Vibe Coder's Bible](https://mnehmos.github.io/vibe-coders-bible/)**
to the concrete tooling of this engine. Read it before changing code; follow it
when you commit.

> **Prime directive.** *Trust AI to propose. Verify before commit.*
> Vibe coding lowers the cost of generation. It does not lower the cost of
> responsibility. The model can produce; only a person can decide.

The engine is a classical, non-NNUE chess engine with a TypeScript reference
core and a native Rust runtime core. The two cores must agree. That agreement,
plus the release speed floor, is what these procedures protect.

---

## 1. Hierarchy of controls in this repo

The Bible orders safety controls from most to least effective. Here is how each
level is actually implemented here — prefer fixing a problem at the highest
level it can live at.

| Level | Principle | Implemented here as |
|---|---|---|
| **Elimination** | Remove the hazard | No secrets, no production database, no network I/O, no destructive commands in the engine. The Rust core is dependency-free. Build artifacts (`rust/**/target/`, `dist/`) are git-ignored, never committed. |
| **Substitution** | Replace raw access with safe tools | All work goes through typed `npm` / `cargo` scripts (`package.json`), never ad-hoc shell against the tree. The TS↔Rust boundary is a JSON contract (`src/rust/core.ts`). |
| **Engineering controls** | Machines catch mistakes | `tsc` typecheck, `vitest` (69 tests), `cargo test` (14 tests), perft correctness, the **1,000,000 NPS release floor**, SPRT/Elo strength gates, and CI running all of it (`.github/workflows/ci.yml`). |
| **Administrative controls** | Process catches mistakes | This SOP, the [Rust parity specs](RUST_PARITY_SPECS.md), the [engine checklist](NON_NNUE_ENGINE_CHECKLIST.md), the Definition of Done, and orderly conventional commits. |
| **PPE** | Individual vigilance | Prompt discipline, code review, this document open while you work. PPE is the *last* line, never the first. |

If a class of bug can be caught by a test or a gate, add the test or the gate.
Do not rely on remembering to be careful.

---

## 2. The Propose / Validate / Commit loop

Every change moves through the same loop. Small loops beat large unreviewed
leaps.

1. **Shape** — the change must have a shape before code is written. For anything
   non-trivial (a new search/eval/UCI behavior, a Rust parity item), write or
   update its spec in [`RUST_PARITY_SPECS.md`](RUST_PARITY_SPECS.md) first:
   problem, reference behavior, target design, acceptance criteria, verification
   commands. *Do not build a feature until the feature has a shape.*
2. **Propose** — implement the smallest coherent slice. Keep the TS reference
   and the Rust runtime in agreement; when they must share a constant (piece
   values, PST, policy weights, SEE thresholds) treat one side as the source of
   truth and add a parity test rather than trusting two hand-copied copies.
3. **Validate** — run the gate sequence in §7. Nothing is "done" on inspection
   alone. If the change can affect strength, run the strength protocol (§5).
4. **Commit** — only after validation, in orderly commits (§6), with the repo
   updated so the next agent inherits the truth (§ "Repo is the memory").

---

## 3. A feature must have a shape (spec-first)

Before writing engine code for anything beyond a trivial fix, there must be a
spec. In this repo that means an entry in
[`RUST_PARITY_SPECS.md`](RUST_PARITY_SPECS.md) (or a sibling design doc) with:

- **Problem** — what runtime behavior is missing or wrong.
- **Reference** — the exact TS symbol(s) that define correct behavior
  (`file.ts:symbol`). The TypeScript core is the behavioral oracle.
- **Target design** — where in `rust/cvs-core/src/main.rs` the change lands,
  which functions/data change, and the output/JSON/UCI contract.
- **Acceptance criteria** — testable statements, including a parity assertion
  against the TS reference where one exists.
- **Verification** — the exact commands that prove it (from §7).
- **Performance budget & strength expectation** — see §4 and §5.
- **Risks** — the silent-failure modes to guard with tests.

A spec that cannot state its acceptance criteria is not ready to build.

---

## 4. Performance protocol (the 1,000,000 NPS floor)

The native search must reach **≥ 1,000,000 NPS** on the fixed depth-6 benchmark
suite before any Cute Chess strength evaluation is meaningful. This is a hard
engineering control, not a target.

- Any change to the search hot path, leaf evaluation, or move ordering **must**
  re-run the speed gate and record before/after NPS:
  ```
  npm run bench:speed:rust:dist -- --depth 6 --target-nps 1000000
  ```
- A change that drops below the floor is a **failing** change, even if it is
  otherwise correct. Buy the speed back (incremental update, cheaper subset,
  lazy computation) or gate the expensive path behind an off-by-default knob.
- Record the measured NPS in the checklist's *Latest Rust Gate Run* section so
  regressions are visible across sessions.

The TypeScript object-board core is the correctness/reference implementation and
is expected to be below the floor; the Rust core is the runtime that must clear
it.

---

## 5. Strength-change protocol

Any change to search, evaluation, ordering, or time management is
**strength-affecting** and cannot be promoted on raw win percentage or "looks
stronger."

- Use **SPRT** (or an equivalent sequential test) against the prior build:
  `src/benchmark/stats.ts` (`runSprt`, `summarizeElo`).
- Report an **Elo estimate with a confidence interval**; use paired/mirrored
  openings to cut book noise; keep engine settings fixed across the A/B (hash,
  threads, policy-ordering, time control).
- Preserve raw artifacts (benchmark JSON, PGNs, UCI logs) and record the
  environment (CPU, OS, Node version, git SHA, build mode, suite version, seed)
  via the manifest (`src/benchmark/manifest.ts`).
- The Cute Chess release configuration lives at
  [`configs/cutechess-rust-classical.json`](../configs/cutechess-rust-classical.json);
  the runbook is [`CUTECHESS_RUST_RELEASE.md`](CUTECHESS_RUST_RELEASE.md).

Neutral or positive SPRT is required to promote a strength-affecting patch.

---

## 6. Bug protocol

*Never fix a bug the engine cannot reproduce, and never fix a bug without a
test.*

1. Reproduce it as a **failing test** first — a FEN + expected value/move/count
   in `vitest` or a `#[test]` in the Rust core. A perft mismatch, a wrong SEE
   swing, and an incremental-eval divergence are all reproducible this way.
2. Fix the code until the test is green.
3. Keep the test. Every bug fixed without a test is a lesson the next agent can
   forget.

---

## 7. Commit & branch discipline

- **Branch** for multi-session or risky work; the Bible's rule is that every AI
  session that modifies code should run on a branch, not `main`. Small, already
  validated changes may go straight to `main` when that matches the maintainer's
  workflow — confirm rather than assume.
- **Orderly commits.** One logical change per commit, foundation first, using
  conventional prefixes (`feat`, `fix`, `docs`, `chore`, `ci`, `refactor`,
  scoped e.g. `feat(rust): …`). Never bundle unrelated changes.
- End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Never commit build artifacts.** `rust/**/target/`, `dist/`, `coverage/`,
  and `*.tsbuildinfo` are git-ignored; keep them that way.
- Commit or push only when asked. Verify (§ gate sequence) *before* you commit,
  not after.

---

## 8. The repo is the memory (agent handoff)

*If the next agent needs to know it, put it in the repo.* When you finish a unit
of work, leave the repository telling the truth:

- Move the item's box in [`NON_NNUE_ENGINE_CHECKLIST.md`](NON_NNUE_ENGINE_CHECKLIST.md)
  and update its spec status in [`RUST_PARITY_SPECS.md`](RUST_PARITY_SPECS.md).
- Update *Latest Rust Gate Run* with the commands you ran and the numbers you
  got (especially NPS).
- Update [`ARCHITECTURE.md`](ARCHITECTURE.md) if a module's contract changed.
- Docs that lie are worse than no docs. If you did not run it, do not check it.

---

## 9. Definition of Done

A change is **Done** only when all of the following hold:

- [ ] It had a shape (spec) before it had code.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (all vitest suites).
- [ ] `npm run rust:test` passes (all cargo tests).
- [ ] `npm run build` and `npm run rust:build` succeed.
- [ ] `npm run bench:perft` passes (move-generation correctness unchanged).
- [ ] Native search still clears the speed floor:
      `npm run bench:speed:rust:dist -- --depth 6 --target-nps 1000000`.
- [ ] TS↔Rust parity tests pass for any shared behavior/constants touched.
- [ ] If strength-affecting: SPRT is neutral-or-positive (§5).
- [ ] The bug (if any) is covered by a regression test (§6).
- [ ] Checklist, specs, and *Latest Rust Gate Run* are updated (§8).
- [ ] Commits are orderly with the co-author trailer (§7).

---

## 10. Gate sequence (copy-paste)

The full local gate, mirroring CI:

```bash
npm run typecheck
npm test
npm run rust:test
npm run bench:perft
npm run build
npm run rust:build
npm run bench:speed:rust:dist -- --depth 6 --target-nps 1000000
```

CI (`.github/workflows/ci.yml`) runs the same sequence on every push and pull
request. A red gate is a blocked change.
