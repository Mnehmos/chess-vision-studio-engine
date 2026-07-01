# Cute Chess Rust Release Gauntlet

This is the strength-evaluation path for the classical Rust runtime after the
correctness and speed gates pass.

Prerequisites:

- `npm ci`
- `npm run build`
- `npm run rust:build`
- `cutechess-cli` on `PATH`
- opponent engine command on `PATH`, for example `stockfish`
- fixed opening file at `data/openings/release.epd`

Configuration:

- Machine-readable config: `configs/cutechess-rust-classical.json`
- Engine under test: `node bin/run-rust-core.cjs uci`
- Protocol: UCI
- Hash: 64 MB
- Threads: 1
- Time control: `40/60+0.6`
- Openings: mirrored, 8 plies, random order from `data/openings/release.epd`
- Output PGN: `artifacts/cutechess/cvs-rust-classical-release.pgn`
- UCI log: `artifacts/cutechess/cvs-rust-classical-release.uci.log`

Example command:

```bash
cutechess-cli \
  -engine name="CVS Rust Classical" cmd="node" arg="bin/run-rust-core.cjs" arg="uci" proto=uci option.Hash=64 option.Threads=1 option.MultiPV=1 \
  -engine name="Stockfish Baseline" cmd="stockfish" proto=uci option.Hash=64 option.Threads=1 \
  -each tc=40/60+0.6 \
  -openings file=data/openings/release.epd format=epd order=random plies=8 \
  -games 2 -rounds 100 -repeat -concurrency 1 \
  -resign movecount=4 score=800 \
  -draw movenumber=40 movecount=8 score=20 \
  -pgnout artifacts/cutechess/cvs-rust-classical-release.pgn \
  -recover
```

Keep the raw PGN and UCI logs. Convert the match results into the gauntlet
artifact JSON consumed by `bench suite` before treating the run as a release
strength gate.
