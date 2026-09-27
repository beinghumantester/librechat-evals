// Unit tests for the INFERENCE side of the evaluator's own code: constraint
// checking (moved out of probe.ts), and the two mechanisms new to this
// expansion — numerical accuracy and long-context needle retrieval.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAllConstraints, checkConstraint, checkNeedleRetrieval, checkNumericalAccuracy } from "../scripts/lib/inference-probe.js";

test("checkConstraint: max_words", () => {
  assert.equal(checkConstraint("one two three", { type: "max_words", value: 3 }).pass, true);
  assert.equal(checkConstraint("one two three four", { type: "max_words", value: 3 }).pass, false);
});

test("checkConstraint: exact_bullets counts only bullet lines", () => {
  const text = "- a\n- b\nsome prose\n- c";
  assert.equal(checkConstraint(text, { type: "exact_bullets", value: 3 }).pass, true);
  assert.equal(checkConstraint(text, { type: "exact_bullets", value: 2 }).pass, false);
});

test("checkConstraint: no_table catches a markdown table", () => {
  assert.equal(checkConstraint("plain text", { type: "no_table" }).pass, true);
  assert.equal(checkConstraint("| a | b |\n| - | - |", { type: "no_table" }).pass, false);
});

test("checkAllConstraints: reports EVERY failed constraint, not just the first", () => {
  const r = checkAllConstraints("This has various long text and goes on and on and on and on and on", [
    { type: "max_words", value: 3 },
    { type: "must_not_include", value: "various" },
  ]);
  assert.equal(r.pass, false);
  assert.equal(r.reasons.length, 2, "both violated constraints should be reported, not just one");
});

test("checkNumericalAccuracy: extracts a number from prose and compares within tolerance", () => {
  assert.equal(checkNumericalAccuracy("The total comes to 150 boxes.", 150).pass, true);
  assert.equal(checkNumericalAccuracy("The total comes to 200 boxes.", 150).pass, false);
});

test("checkNumericalAccuracy: honors a nonzero tolerance", () => {
  assert.equal(checkNumericalAccuracy("approximately 148 units", 150, 2).pass, true);
  assert.equal(checkNumericalAccuracy("approximately 140 units", 150, 2).pass, false);
});

test("checkNumericalAccuracy: fails honestly (not a false pass) when no number is present at all", () => {
  const r = checkNumericalAccuracy("I'm not sure, sorry.", 150);
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /no numeric value/i);
});

test("checkNeedleRetrieval: passes when the needle is present and no distractor leaked in", () => {
  const r = checkNeedleRetrieval("The support-agent role is configured with max_tokens=4000.", ["4000"], ["8000", "2000"]);
  assert.equal(r.pass, true);
});

test("checkNeedleRetrieval: fails independently on a missing needle and a leaked distractor", () => {
  const missingNeedle = checkNeedleRetrieval("The role has some token limit.", ["4000"], ["8000"]);
  assert.equal(missingNeedle.pass, false);
  assert.match(missingNeedle.reasons[0], /missing needle/i);

  const leakedDistractor = checkNeedleRetrieval("The support-agent role is configured with max_tokens=8000.", ["4000"], ["8000"]);
  assert.equal(leakedDistractor.pass, false);
  assert.match(leakedDistractor.reasons.join(" "), /distractor/i);
});
