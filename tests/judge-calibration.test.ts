// Unit tests for the confusion-matrix math behind judge calibration — pure computation,
// zero network/API dependency. The actual judge-accuracy NUMBERS (scripts/run-judge-
// calibration.ts) require ANTHROPIC_API_KEY and are not produced by this test file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfusionStats, type LabeledRow } from "../scripts/lib/judge-calibration.js";

function row(id: string, expected: "PASS" | "FAIL", observed: "PASS" | "FAIL"): LabeledRow {
  return { id, suite: "calibration", expected, observed };
}

test("computeConfusionStats: perfect agreement gives 100% on every metric", () => {
  const rows = [row("a", "PASS", "PASS"), row("b", "FAIL", "FAIL"), row("c", "PASS", "PASS")];
  const s = computeConfusionStats(rows);
  assert.equal(s.tp, 2);
  assert.equal(s.tn, 1);
  assert.equal(s.fp, 0);
  assert.equal(s.fn, 0);
  assert.equal(s.accuracy, 1);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
  assert.equal(s.f1, 1);
});

test("computeConfusionStats: a false positive (judge PASSes something a human labeled FAIL) is counted correctly and drags precision down, not recall", () => {
  const rows = [row("a", "PASS", "PASS"), row("b", "FAIL", "PASS")];
  const s = computeConfusionStats(rows);
  assert.equal(s.tp, 1);
  assert.equal(s.fp, 1);
  assert.equal(s.tn, 0);
  assert.equal(s.fn, 0);
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 1, "recall is unaffected by a false positive — every true PASS was still found");
});

test("computeConfusionStats: a false negative (judge FAILs something a human labeled PASS) drags recall down, not precision", () => {
  const rows = [row("a", "PASS", "FAIL"), row("b", "FAIL", "FAIL")];
  const s = computeConfusionStats(rows);
  assert.equal(s.fn, 1);
  assert.equal(s.tn, 1);
  assert.equal(s.recall, 0);
  assert.equal(s.precision, 0, "no predicted PASS was ever correct, so precision is 0 here — tp=0 and fp=0 both");
});

test("computeConfusionStats: empty input never divides by zero", () => {
  const s = computeConfusionStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.accuracy, 0);
  assert.equal(s.precision, 0);
  assert.equal(s.recall, 0);
  assert.equal(s.f1, 0);
});
