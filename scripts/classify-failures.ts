#!/usr/bin/env tsx
// Applies the F01-F26 failure taxonomy from LIBRECHAT_EVAL_PLAN.md's Phase 11 to a real run's
// non-PASS results — turning the taxonomy from a documentation list into an actually-applied
// classification, per the review recommendation ("turn failures into reusable knowledge").
//
// THREE SEPARATE DIMENSIONS, kept separate on purpose (a second review specifically flagged
// the risk of collapsing these into one string): a failure category (F01-F26 — WHAT happened,
// a property of the case/check) is not the same thing as an attribution (WHY/WHERE it
// happened — a property of THIS run, against THIS system-under-test) is not the same thing as
// SUT status (whether real-system evidence exists at all). Two cases with the identical F-code
// can have completely different attributions once real reconnaissance exists; conflating them
// into one label would make that future distinction impossible to draw cleanly.
//
// HONESTY CAVEAT: every case classified here ran against the MOCK, not real LibreChat, and
// every FAIL below was produced by a directive the harness itself told the mock to simulate
// (see mock-server/server.ts's x-mock-directives header) — these are deliberately-scripted
// negative controls, not emergent bugs discovered in a real system. So every FAIL's attribution
// is "Mock-scripted negative control," and every row's sutStatus is "Not established" — that
// second field is what changes, case by case, once real reconnaissance happens; nothing here
// should be read as a claim about LibreChat itself. The two BLOCKED rows are the genuine
// exceptions: AGT-011 is a real evidence limitation (the native SSE route legitimately carries
// no structured tool trace) and INF-023 is a real harness/process gap (no golden captured
// yet) — both true regardless of what a real LibreChat instance eventually shows.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSummary, EvalCategory } from "./lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Dimension 1: failure category. One F-code per category. Where a category can fail in more
// than one taxonomy-distinct way (tool_selection: a missing required tool vs. a forbidden tool
// called), the reason text is inspected to pick the more specific code; otherwise this is the
// category's default. This dimension answers "what happened," and never changes based on which
// system produced the result.
const CATEGORY_CODE: Partial<Record<EvalCategory, string>> = {
  tool_selection: "F06 Missing required tool",
  tool_arguments: "F07 Wrong tool arguments",
  tool_result_grounding: "F09 Tool-result contradiction",
  tool_failure_recovery: "F10 Tool failure recovery",
  termination: "F11 Tool loop",
  instruction_following: "F04 Instruction violation",
  constraint_satisfaction: "F04 Instruction violation",
  factual_correctness: "F01 Wrong answer",
  numerical_accuracy: "F01 Wrong answer",
  long_context: "F13 Retrieval failure",
  security_prompt_injection: "F16 Prompt injection",
  security_indirect_injection: "F17 Indirect prompt injection",
  security_data_leakage: "F18 Data leakage",
  security_privilege_escalation: "F19 Unauthorized action",
};

function categoryCodeFor(category: EvalCategory, reasons: string[]): string {
  const joined = reasons.join(" ");
  if (category === "tool_selection" && /forbidden tool/i.test(joined)) return "F08 Unnecessary tool call";
  return CATEGORY_CODE[category] ?? "(uncategorized — extend CATEGORY_CODE)";
}

// Dimension 2: attribution. WHY/WHERE this result came from, specific to this run against this
// system. Not a property of the case — the same case could get a different attribution against
// a different system (e.g. a real LibreChat instance producing the identical F-code failure for
// a genuinely different, emergent reason).
type Attribution = "Mock-scripted negative control" | "Evidence limitation (gate)" | "Harness/process limitation" | "Uncategorized non-execution";

function attributionFor(verdict: string, nonExecutionReason: string | undefined): Attribution {
  if (verdict === "BLOCKED") {
    if (nonExecutionReason?.includes("MISSING_EVIDENCE")) return "Evidence limitation (gate)";
    if (nonExecutionReason?.toLowerCase().includes("no golden reference")) return "Harness/process limitation";
    return "Uncategorized non-execution";
  }
  // Every FAIL in the current suite came from a directive the harness itself asked the mock to
  // simulate — see the file header. If a future run adds a category where a FAIL could be
  // genuinely emergent rather than scripted, this function is where that distinction gets made.
  return "Mock-scripted negative control";
}

// Dimension 3: SUT status. Whether real-system evidence exists AT ALL for this row, independent
// of category or attribution. Every row is "Not established" until real reconnaissance runs —
// this is the field a future real run will actually change, per case.
function sutStatusFor(): string {
  return "Not established (mock-backed run, no real LibreChat evidence yet)";
}

function latestRunFile(): string {
  const runsDir = join(ROOT, "runs");
  const files = readdirSync(runsDir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error("no run-*.json found in runs/ — run `npm run evals:deterministic` first");
  }
  files.sort();
  return join(runsDir, files[files.length - 1]);
}

function main() {
  const runPath = process.argv[2] ? join(ROOT, process.argv[2]) : latestRunFile();
  const run: RunSummary = JSON.parse(readFileSync(runPath, "utf-8"));

  const rows = run.results
    .filter((r) => r.verdict === "FAIL" || r.verdict === "BLOCKED")
    .map((r) => ({
      id: r.id,
      category: r.category,
      verdict: r.verdict,
      failureCategory: r.verdict === "FAIL" ? categoryCodeFor(r.category, r.reasons ?? []) : "(non-execution — no failure category applies)",
      attribution: attributionFor(r.verdict, r.nonExecutionReason),
      sutStatus: sutStatusFor(),
      reason: (r.reasons ?? []).join("; ") || r.nonExecutionReason || "",
    }));

  const relativeRunPath = runPath.startsWith(ROOT) ? runPath.slice(ROOT.length + 1) : runPath;
  console.log(`Failure taxonomy classification — source: ${relativeRunPath}`);
  console.log(`${rows.length} non-PASS cases classified\n`);
  for (const row of rows) {
    console.log(`${row.id.padEnd(9)} ${row.category.padEnd(24)} ${row.verdict.padEnd(8)} ${row.failureCategory}`);
    console.log(`          reason:      ${row.reason.slice(0, 140)}`);
    console.log(`          attribution: ${row.attribution}`);
    console.log(`          SUT status:  ${row.sutStatus}\n`);
  }

  const outPath = join(ROOT, "docs", "failure-taxonomy-latest.json");
  writeFileSync(outPath, JSON.stringify({ sourceRun: relativeRunPath, generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`Machine-readable classification written to ${outPath}`);
}

main();
