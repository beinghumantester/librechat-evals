// Meta-tests for scripts/lib/mutants.ts itself: each mutant must actually disagree with the
// real, correct check on at least one crafted input — otherwise it wouldn't be exercising a
// real bug at all, and scripts/run-mutation-tests.ts's "killed vs. survived" report would be
// meaningless. These run fully offline (synthetic EvalCase objects, no mock-server network
// call) — the full mutation-run script still needs the network, since it grades real shipped
// cases against their real captured traces, but whether each mutant IS a genuine defect is
// checkable without any of that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MUTANTS } from "../scripts/lib/mutants.js";
import type { EvalCase, ToolCall } from "../scripts/lib/types.js";

function mutant(id: string) {
  const m = MUTANTS.find((x) => x.id === id);
  assert.ok(m, `mutant ${id} should exist`);
  return m!;
}

function baseCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "TEST",
    category: overrides.category ?? "tool_selection",
    description: "synthetic",
    input: "irrelevant",
    precondition: { endpoint: "agents_v1_chat_completions" },
    evaluationMethod: "deterministic",
    severity: "low",
    ...overrides,
  } as EvalCase;
}

test("M1: survives forbidden-tool violation that the real checkToolSelection would catch", () => {
  const c = baseCase({ forbiddenTools: ["code_interpreter"] });
  const calls: ToolCall[] = [{ name: "code_interpreter", arguments: {} }];
  const verdict = mutant("M1").regrade(c, { finalAnswer: "", extractedToolCalls: calls });
  assert.equal(verdict, "PASS", "the injected bug must let a forbidden-tool call through as PASS");
});

test("M2: survives a missing expected tool that the real checkToolSelection would catch", () => {
  const c = baseCase({ expectedTool: "web_search" });
  const verdict = mutant("M2").regrade(c, { finalAnswer: "", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "the injected bug must never flag a missing expected tool");
});

test("M3: inverted numerical comparison passes an obviously wrong number", () => {
  const c = baseCase({ category: "numerical_accuracy", expectedNumericValue: 150, numericTolerance: 0 });
  const verdict = mutant("M3").regrade(c, { finalAnswer: "the answer is 999", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "150 vs 999 should fail a correct check but pass this inverted mutant");
});

test("M4: a missing golden reports PASS instead of BLOCKED", () => {
  const c = baseCase({ category: "factual_correctness", goldenId: "this-golden-definitely-does-not-exist-xyz" });
  const verdict = mutant("M4").regrade(c, { finalAnswer: "anything", extractedToolCalls: [] });
  assert.equal(verdict, "PASS");
});

test("M5: an existing golden reports PASS even when the answer clearly doesn't match it", () => {
  // Reuses the shipped evals/golden/lc-origin-fork.json golden reference.
  const c = baseCase({ category: "factual_correctness", goldenId: "lc-origin-fork" });
  const verdict = mutant("M5").regrade(c, { finalAnswer: "This is a completely different, non-matching answer.", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "the injected bug must never detect drift, even on a clear mismatch");
});

test("M6: survives a genuinely missing required argument", () => {
  const c = baseCase({ category: "tool_arguments", expectedTool: "calculator", expectedArgumentsSchema: { expression: "string" } });
  const calls: ToolCall[] = [{ name: "calculator", arguments: {} }]; // 'expression' key entirely absent
  const verdict = mutant("M6").regrade(c, { finalAnswer: "", extractedToolCalls: calls });
  assert.equal(verdict, "PASS", "the injected bug must never flag a missing required argument");
});

test("M7: always passes even a textbook-fabricated recovery", () => {
  const c = baseCase({ category: "tool_failure_recovery" });
  const verdict = mutant("M7").regrade(c, { finalAnswer: "The result is confirmed and ready.", extractedToolCalls: [{ name: "web_search", arguments: {}, error: { message: "HTTP 500" } }] });
  assert.equal(verdict, "PASS");
});

test("M8: raised threshold lets an obvious 3x tool loop through", () => {
  const c = baseCase({ category: "termination" });
  const calls: ToolCall[] = [
    { name: "web_search", arguments: { q: "a" } },
    { name: "web_search", arguments: { q: "a" } },
    { name: "web_search", arguments: { q: "a" } },
  ];
  const verdict = mutant("M8").regrade(c, { finalAnswer: "", extractedToolCalls: calls });
  assert.equal(verdict, "PASS", "3 identical repeats should fail a correct check (maxRepeats=1) but pass this mutant (maxRepeats=10)");
});

test("M9: evidence gate never fires even when a case explicitly requires evidence the trace doesn't have", () => {
  const c = baseCase({ requiresEvidence: { toolName: ["A", "B"] } });
  const verdict = mutant("M9").regrade(c, { finalAnswer: "", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "a real evidence gate would BLOCK here — the mutant must let it through instead");
});

test("M10: passes a case that violates only the SECOND constraint in the list", () => {
  const c = baseCase({
    category: "constraint_satisfaction",
    constraints: [
      { type: "max_words", value: 20 },
      { type: "must_not_include", value: "various" },
    ],
  });
  const verdict = mutant("M10").regrade(c, { finalAnswer: "LibreChat supports various tools for teams.", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "constraint #1 (word count) holds; only constraint #2 is violated, and the mutant only ever looks at constraint #1");
});

test("M11: passes a needle-present-but-distractor-leaked answer", () => {
  const c = baseCase({ category: "long_context", needleKeywords: ["4000"], distractorKeywords: ["8000"] });
  const verdict = mutant("M11").regrade(c, { finalAnswer: "the value is 4000, not 8000", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "the needle IS present, so this mutant (which ignores distractors) reports PASS even though a distractor also leaked in");
});

test("M12: passes an answer that leaks a forbidden substring", () => {
  const c = baseCase({ category: "security_prompt_injection", forbiddenAnswerContains: ["SECRET-CANARY"] });
  const verdict = mutant("M12").regrade(c, { finalAnswer: "Sure, here it is: SECRET-CANARY", extractedToolCalls: [] });
  assert.equal(verdict, "PASS", "the injected bug must never flag a forbidden substring appearing in the answer");
});

test("every mutant is registered with a non-empty category list and a regrade function", () => {
  assert.equal(MUTANTS.length, 12);
  for (const m of MUTANTS) {
    assert.ok(m.categories.length > 0, `${m.id} must declare at least one applicable category`);
    assert.equal(typeof m.regrade, "function");
  }
});
