#!/usr/bin/env tsx
// CLI: runs every hand-labeled case in evals/evaluator/judge-cases.json through the real
// judge (judgeWithVoting) and reports accuracy against the human labels — split by suite,
// since "calibration" (ordinary labeled examples) and "injection" (candidate answers that
// try to manipulate the grader itself) are different failure modes worth seeing separately.
// Costs real Anthropic API budget (small, by design — see judge-cases.json's own comment
// about keeping this corpus deliberately small rather than a giant benchmark).

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasApiKey, judgeWithVoting, type UsageAccumulator } from "./lib/anthropic-client.js";
import { computeConfusionStats, loadJudgeCases, type LabeledRow } from "./lib/judge-calibration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function printStats(label: string, rows: LabeledRow[]) {
  const s = computeConfusionStats(rows);
  console.log(`\n${label}: n=${s.n}  TP=${s.tp} TN=${s.tn} FP=${s.fp} FN=${s.fn}`);
  console.log(`  accuracy=${(s.accuracy * 100).toFixed(1)}%  precision=${(s.precision * 100).toFixed(1)}%  recall=${(s.recall * 100).toFixed(1)}%  f1=${(s.f1 * 100).toFixed(1)}%`);
  if (s.fp > 0) {
    console.log(`  ${s.fp} false positive(s): the judge PASSed something a human labeled FAIL — the dangerous direction, doubly so for the injection suite.`);
  }
}

async function main() {
  if (!hasApiKey()) {
    console.log("ANTHROPIC_API_KEY not set — judge calibration needs the real judge tier, so there is nothing to run.");
    console.log("This is reported the same way the harness reports any other missing-evidence case: as an honest non-result, not a score.");
    process.exitCode = 0;
    return;
  }

  const cases = loadJudgeCases(join(ROOT, "evals"));
  if (cases.length === 0) {
    console.log("No cases found in evals/evaluator/judge-cases.json.");
    return;
  }
  console.log(`librechat-evals judge calibration — ${cases.length} hand-labeled cases`);

  const usage: UsageAccumulator = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const rows: LabeledRow[] = [];

  for (const c of cases) {
    process.stdout.write(`  ${c.id} (${c.suite})... `);
    const judged = await judgeWithVoting(c.input, c.answerText, c.judgeExpectations, usage);
    const row: LabeledRow = { id: c.id, suite: c.suite, expected: c.humanLabel, observed: judged.verdict };
    rows.push(row);
    console.log(`human=${c.humanLabel} judge=${judged.verdict} ${row.expected === row.observed ? "match" : "MISMATCH"}`);
  }

  printStats("Overall", rows);
  printStats("Calibration suite only", rows.filter((r) => r.suite === "calibration"));
  printStats("Injection suite only", rows.filter((r) => r.suite === "injection"));

  console.log(`\nAnthropic judge calls: ${usage.calls}  (input ${usage.inputTokens} tok, output ${usage.outputTokens} tok)`);
  console.log("Reminder: 'judge agreement is not judge accuracy' — this measures the latter, against a deliberately small labeled corpus, not a giant benchmark.");

  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const filename = `judge-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(
    join(ROOT, "runs", filename),
    JSON.stringify(
      {
        overall: computeConfusionStats(rows),
        calibration: computeConfusionStats(rows.filter((r) => r.suite === "calibration")),
        injection: computeConfusionStats(rows.filter((r) => r.suite === "injection")),
        rows,
        anthropicApiCalls: usage.calls,
        anthropicInputTokens: usage.inputTokens,
        anthropicOutputTokens: usage.outputTokens,
      },
      null,
      2,
    ),
  );
  console.log(`Report: runs/${filename}`);

  const anyFalsePositive = rows.some((r) => r.expected === "FAIL" && r.observed === "PASS");
  if (anyFalsePositive) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
