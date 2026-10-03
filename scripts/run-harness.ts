#!/usr/bin/env tsx
// CLI entrypoint. Loads evals/cases.json, grades each case whose category
// matches --category, writes a timestamped report to runs/, and exits
// non-zero on any FAIL/ERROR (never on BLOCKED/UNVERIFIED/NOT_APPLICABLE —
// those are honest non-results, not failures, per LIBRECHAT_EVAL_PLAN.md).

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeCase } from "./lib/grader.js";
import { baseUrl } from "./lib/librechat-client.js";
import { loadAllCases } from "./lib/load-cases.js";
import type { EvalCase, GradeResult, GradeVerdict, RunSummary } from "./lib/types.js";
import type { UsageAccumulator } from "./lib/anthropic-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(): { categories: string[] | "all" } {
  const arg = process.argv.find((a) => a.startsWith("--category"));
  if (!arg) return { categories: "all" };
  const value = arg.includes("=") ? arg.split("=")[1] : process.argv[process.argv.indexOf(arg) + 1];
  if (!value || value === "all") return { categories: "all" };
  return { categories: value.split(",").map((s) => s.trim()) };
}

async function main() {
  const { categories } = parseArgs();
  const allCases: EvalCase[] = loadAllCases(join(ROOT, "evals"));
  const cases = categories === "all" ? allCases : allCases.filter((c) => categories.includes(c.category));

  console.log(`librechat-evals — running ${cases.length} of ${allCases.length} cases against ${baseUrl()}`);
  if (cases.length === 0) {
    console.log("No cases matched --category. Nothing to run.");
    return;
  }

  const usage: UsageAccumulator = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const results: GradeResult[] = [];
  const startedAt = new Date().toISOString();

  for (const c of cases) {
    process.stdout.write(`  ${c.id} (${c.category})... `);
    const result = await gradeCase(c, usage);
    results.push(result);
    console.log(result.verdict + (result.nonExecutionReason ? ` — ${result.nonExecutionReason}` : result.reasons.length ? ` — ${result.reasons[0]}` : ""));
  }

  const finishedAt = new Date().toISOString();
  const byVerdict: Record<GradeVerdict, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_APPLICABLE: 0, UNVERIFIED: 0, ERROR: 0 };
  for (const r of results) byVerdict[r.verdict]++;

  // Self-check: for every case that carries its own expectedVerdict label, did the observed
  // verdict actually match it? BLOCKED never counts as a mismatch (see the GradeVerdict
  // contract in types.ts) — grader.ts already encodes that when it sets labelMatch.
  const labelMismatches = results.filter((r) => r.labelMatch === false).map((r) => r.id);

  const summary: RunSummary = {
    startedAt,
    finishedAt,
    baseUrl: baseUrl(),
    totalCases: results.length,
    byVerdict,
    labelMismatches,
    anthropicApiCalls: usage.calls,
    anthropicInputTokens: usage.inputTokens,
    anthropicOutputTokens: usage.outputTokens,
    results,
  };

  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const filename = `run-${startedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(ROOT, "runs", filename), JSON.stringify(summary, null, 2));

  console.log("\n--- Summary ---");
  console.log(`PASS ${byVerdict.PASS}  FAIL ${byVerdict.FAIL}  BLOCKED ${byVerdict.BLOCKED}  UNVERIFIED ${byVerdict.UNVERIFIED}  NOT_APPLICABLE ${byVerdict.NOT_APPLICABLE}  ERROR ${byVerdict.ERROR}`);
  if (labelMismatches.length > 0) {
    console.log(`\nLABEL MISMATCH — ${labelMismatches.length} case(s) disagreed with their own expectedVerdict: ${labelMismatches.join(", ")}`);
    console.log("This is a self-check on the harness, not a finding about LibreChat — either a case's label is wrong or a check regressed. See runs/ for details.");
  }
  if (usage.calls > 0) {
    console.log(`Anthropic judge calls: ${usage.calls}  (input ${usage.inputTokens} tok, output ${usage.outputTokens} tok)`);
  }
  console.log(`Report: runs/${filename}`);

  const byCategory = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { pass: 0, fail: 0 };
    if (r.verdict === "PASS") entry.pass++;
    if (r.verdict === "FAIL") entry.fail++;
    byCategory.set(r.category, entry);
  }
  if (byCategory.size > 0) {
    console.log("\nPer category (PASS/FAIL only — see the report for BLOCKED/UNVERIFIED reasons):");
    for (const [cat, { pass, fail }] of byCategory) {
      console.log(`  ${cat}: ${pass} pass, ${fail} fail`);
    }
  }

  // Exit non-zero on ERROR (a harness defect) or a label mismatch (a case behaving
  // differently than its own author designed it to) — but NOT on FAIL alone, since a FAIL on
  // a case whose expectedVerdict IS "FAIL" (a negative control) is the harness working
  // correctly, not a build-breaking problem. A previous version of this script exited
  // non-zero on any FAIL, which — given every shipped case set intentionally includes
  // negative controls that are SUPPOSED to fail — would have made "safe as a required CI
  // check" false on every single run. expectedVerdict + labelMatch is what makes "FAIL that
  // was designed to happen" and "FAIL that means something broke" distinguishable at all.
  if (byVerdict.ERROR > 0 || labelMismatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
