#!/usr/bin/env tsx
// CLI to pin a reference answer for a goldenId, the same discipline as
// camelid-evals' capture-golden.ts: run the case for real, print what was
// captured so a human can eyeball it before committing, and never
// overwrite an existing golden silently.
//
// Usage: tsx scripts/capture-golden.ts <goldenId> <caseId> [--force]

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "./lib/grader.js";
import { readGolden, writeGolden } from "./lib/golden-store.js";
import { loadAllCases } from "./lib/load-cases.js";
import { baseUrl } from "./lib/librechat-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

async function main() {
  const [goldenId, caseId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  if (!goldenId || !caseId) {
    console.error("Usage: tsx scripts/capture-golden.ts <goldenId> <caseId> [--force]");
    process.exitCode = 1;
    return;
  }

  if (!force && readGolden(goldenId)) {
    console.error(`A golden already exists for '${goldenId}'. Re-run with --force to overwrite it (do this deliberately, after eyeballing the new answer — this is what stands in for "known-correct" until you change it).`);
    process.exitCode = 1;
    return;
  }

  const allCases = loadAllCases(join(ROOT, "evals"));
  const c = allCases.find((x) => x.id === caseId);
  if (!c) {
    console.error(`No case with id '${caseId}' found across evals/*/cases.json.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${caseId} against ${baseUrl()} to capture golden '${goldenId}'...`);
  const { finalAnswer } = await runCase(c);

  writeGolden({ goldenId, caseId, capturedAt: new Date().toISOString(), baseUrl: baseUrl(), answerText: finalAnswer });

  console.log(`\nCaptured golden '${goldenId}' from case '${caseId}':\n---\n${finalAnswer}\n---`);
  console.log(`\nWritten to evals/golden/${goldenId}.json. Eyeball it before committing — this harness will treat it as ground truth for every future run of any case with goldenId="${goldenId}".`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
