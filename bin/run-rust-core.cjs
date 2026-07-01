#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const exe = process.platform === "win32" ? "cvs-rust-core.exe" : "cvs-rust-core";
const binary = resolve(process.cwd(), "rust", "cvs-core", "target", "release", exe);

if (!existsSync(binary)) {
  console.error("Rust core binary not found. Run `npm run rust:build` first.");
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
