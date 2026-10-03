#!/usr/bin/env tsx
// Evaluator mutation testing (LIBRECHAT_EVAL_PLAN.md's evaluator-validation addendum).
// For each mutant in scripts/lib/mutants.ts, re-grades every applicable shipped case using
// the mutant's deliberately broken check instead of the real one, and checks whether the
// result still matches the case's own `expectedVerdict` label. A mutant that still matches
// every label despite being wrong "survives" — that's a real, named blind spot in the case
// suite, not a passing grade. Zero Anthropic API cost: every mutant targets a deterministic
// check, so this only talks to the mock/real LibreChat endpoint, never the judge tier.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "./lib/grader.js";
import { classifyEvidenceGrade } from "./lib/probe.js";
import { loadAllCases } from "./lib/load-cases.js";
import { MUTANTS } from "./lib/mutants.js";
import { baseUrl } from "./lib/librechat-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface MutantResult {
  id: string;
  targetFunction: string;
  description: string;
  status: "killed" | "survived" | "no-applicable-cases";
  casesChecked: number;
  casesSkipped: number;
  killedBy: string[];
}

async function main() {
  const allCases = loadAllCases(join(ROOT, "evals"));
  console.log(`librechat-evals mutation testing — ${MUTANTS.length} mutants, ${allCases.length} shipped cases, against ${baseUrl()}`);
  console.log("Zero Anthropic API cost: every mutant targets a deterministic check.\n");

  const results: MutantResult[] = [];

  for (const mutant of MUTANTS) {
    process.stdout.write(`  ${mutant.id} (${mutant.targetFunction})... `);
    // A BLOCKED-labeled case is only a legitimate candidate for a mutant that IS a gate
    // (regradesGateLogic: true, set on M4/M5/M9) — see mutants.ts's "MUTATION-TESTING
    // META-BUG" file-header note for why an ordinary check-mutant can never legitimately be
    // killed by a BLOCKED case (the real grader's gate short-circuits before that check would
    // ever run, so the bug couldn't have changed that case's real observed verdict either way).
    const candidates = allCases.filter(
      (c) =>
        mutant.categories.includes(c.category) &&
        c.expectedVerdict !== undefined &&
        (c.expectedVerdict !== "BLOCKED" || mutant.regradesGateLogic === true),
    );
    const killedBy: string[] = [];
    let checked = 0;
    let skipped = 0;

    for (const c of candidates) {
      const { response, finalAnswer } = await runCase(c);
      const { extractedToolCalls } = classifyEvidenceGrade(response, finalAnswer);
      const verdict = mutant.regrade(c, { finalAnswer, extractedToolCalls });
      if (verdict === null) {
        skipped++;
        continue;
      }
      checked++;
      if (verdict !== c.expectedVerdict) killedBy.push(c.id);
    }

    const status: MutantResult["status"] = checked === 0 ? "no-applicable-cases" : killedBy.length > 0 ? "killed" : "survived";
    results.push({ id: mutant.id, targetFunction: mutant.targetFunction, description: mutant.description, status, casesChecked: checked, casesSkipped: skipped, killedBy });
    console.log(status === "killed" ? `KILLED (by ${killedBy.join(", ")})` : status === "survived" ? "SURVIVED" : "no applicable cases");
  }

  const killed = results.filter((r) => r.status === "killed").length;
  const survived = results.filter((r) => r.status === "survived").length;
  const scoreEligible = killed + survived;
  const score = scoreEligible > 0 ? (killed / scoreEligible) * 100 : 0;

  console.log("\n--- Mutation score ---");
  console.log(`${killed} / ${scoreEligible} killed (${score.toFixed(1)}%)`);
  if (survived > 0) {
    console.log(`\nSurviving mutants — these name exactly where the evaluator is currently blind:`);
    for (const r of results.filter((x) => x.status === "survived")) {
      console.log(`  ${r.id}: ${r.targetFunction} — ${r.description}`);
    }
  }
  const noApplicable = results.filter((r) => r.status === "no-applicable-cases");
  if (noApplicable.length > 0) {
    console.log(`\nNo applicable cases (not counted in the score — nothing in the current suite exercises this mutant's target at all):`);
    for (const r of noApplicable) console.log(`  ${r.id}: ${r.targetFunction}`);
  }

  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const filename = `mutation-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(ROOT, "runs", filename), JSON.stringify({ baseUrl: baseUrl(), killed, survived, scoreEligible, score, results }, null, 2));
  console.log(`\nReport: runs/${filename}`);

  if (survived > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
