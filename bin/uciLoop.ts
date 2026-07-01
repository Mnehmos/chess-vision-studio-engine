import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { UciSession, type UciSessionOptions } from "../src/uci.js";

export function runUciLoop(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: UciSessionOptions = {},
): void {
  const session = new UciSession(options);
  const rl = createInterface({ input, output, terminal: false });

  rl.on("line", (line) => {
    for (const response of session.processLine(line)) {
      output.write(`${response}\n`);
    }
    if (session.quitRequested) rl.close();
  });
}
