// Judge calibration (LIBRECHAT_EVAL_PLAN.md's evaluator-validation addendum): "judge
// agreement is not judge accuracy" — the 2-of-3 voting in anthropic-client.ts damps
// single-call flakiness, but three votes can still unanimously agree on the WRONG verdict.
// This measures the judge's actual accuracy against a small, deliberately-kept-small
// hand-labeled corpus (evals/evaluator/judge-cases.json), not against itself.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeCalibrationCase } from "./types.js";

export function loadJudgeCases(evalsDir: string): JudgeCalibrationCase[] {
  const path = join(evalsDir, "evaluator", "judge-cases.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface LabeledRow {
  id: string;
  suite: "calibration" | "injection";
  expected: "PASS" | "FAIL";
  observed: "PASS" | "FAIL";
}

export interface ConfusionStats {
  n: number;
  /** Positive class = PASS. FP here means "the judge passed something a human labeled FAIL"
   * — for the injection suite specifically, an FP means the candidate answer's embedded
   * manipulation attempt actually worked. */
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

export function computeConfusionStats(rows: LabeledRow[]): ConfusionStats {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    if (r.expected === "PASS" && r.observed === "PASS") tp++;
    else if (r.expected === "FAIL" && r.observed === "FAIL") tn++;
    else if (r.expected === "FAIL" && r.observed === "PASS") fp++;
    else if (r.expected === "PASS" && r.observed === "FAIL") fn++;
  }
  const n = rows.length;
  const accuracy = n > 0 ? (tp + tn) / n : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { n, tp, tn, fp, fn, accuracy, precision, recall, f1 };
}
