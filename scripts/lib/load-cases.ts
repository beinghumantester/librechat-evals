// Loads every evals/<domain>/cases.json file and merges them — shared by
// run-harness.ts and capture-golden.ts. Domain-per-folder (inference/,
// agents/, security/) instead of one flat file: this is the actual "camelid
// structure" this project's evals/ was missing before — camelid-evals keeps
// one cases.json per domain (self-conformance/, regression-museum/, ...),
// and the first cut of this project flattened all of LibreChat's domains
// into a single evals/cases.json instead of following that pattern.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./types.js";

export function loadAllCases(evalsDir: string): EvalCase[] {
  const entries = readdirSync(evalsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const all: EvalCase[] = [];
  for (const dir of entries) {
    const casesPath = join(evalsDir, dir.name, "cases.json");
    if (existsSync(casesPath)) {
      const parsed: EvalCase[] = JSON.parse(readFileSync(casesPath, "utf8"));
      all.push(...parsed);
    }
  }
  return all;
}
