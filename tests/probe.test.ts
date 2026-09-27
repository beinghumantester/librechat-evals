// Unit tests for the AGENT-TRACE side of the evaluator's own code. Pure
// inference checks (constraints, numerical accuracy, needle retrieval) are
// tested separately in tests/inference-probe.test.ts. Both run with zero
// network dependency, per LIBRECHAT_EVAL_PLAN.md's "evaluator validation"
// principle: the evaluator is a second system under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkFailureRecovery,
  checkTermination,
  checkToolArguments,
  checkToolResultGrounding,
  checkToolSelection,
  classifyEvidenceGrade,
} from "../scripts/lib/probe.js";
import type { ChatCompletionResponse } from "../scripts/lib/types.js";

test("classifyEvidenceGrade: grade A when tool_trace is present", () => {
  const response: ChatCompletionResponse = {
    choices: [{ message: { content: "done" } }],
    tool_trace: [{ name: "web_search", arguments: { query: "x" }, result: "y" }],
  };
  const { grade, extractedToolCalls } = classifyEvidenceGrade(response, "done");
  assert.equal(grade, "A");
  assert.equal(extractedToolCalls[0].name, "web_search");
});

test("classifyEvidenceGrade: grade A from OpenAI-shaped tool_calls, even without a result", () => {
  const response: ChatCompletionResponse = {
    choices: [{ message: { content: "", tool_calls: [{ id: "1", function: { name: "calculator", arguments: '{"expression":"2+2"}' } }] } }],
  };
  const { grade, extractedToolCalls } = classifyEvidenceGrade(response, "");
  assert.equal(grade, "A");
  assert.deepEqual(extractedToolCalls[0].arguments, { expression: "2+2" });
  assert.equal(extractedToolCalls[0].result, undefined);
});

test("classifyEvidenceGrade: grade C from narration text only, never fabricates arguments", () => {
  const response: ChatCompletionResponse = { choices: [{ message: { content: "I searched the web for this and found..." } }] };
  const { grade, extractedToolCalls } = classifyEvidenceGrade(response, "I searched the web for this and found...");
  assert.equal(grade, "C");
  assert.equal(extractedToolCalls[0].name, "web_search");
  assert.deepEqual(extractedToolCalls[0].arguments, {});
});

test("classifyEvidenceGrade: grade D when nothing is present — never invents a tool call", () => {
  const response: ChatCompletionResponse = { choices: [{ message: { content: "Here is a plain answer with no tool mention." } }] };
  const { grade, extractedToolCalls } = classifyEvidenceGrade(response, "Here is a plain answer with no tool mention.");
  assert.equal(grade, "D");
  assert.equal(extractedToolCalls.length, 0);
});

test("checkToolSelection: flags a missing required tool and a forbidden tool independently", () => {
  const observed = [{ name: "code_interpreter", arguments: {} }];
  const r1 = checkToolSelection(observed, "web_search", undefined);
  assert.equal(r1.pass, false);
  const r2 = checkToolSelection(observed, undefined, ["code_interpreter"]);
  assert.equal(r2.pass, false);
  const r3 = checkToolSelection(observed, "code_interpreter", ["web_search"]);
  assert.equal(r3.pass, true);
});

test("checkToolArguments: type-checks each schema key against the actual call", () => {
  const observed = [{ name: "calculator", arguments: { expression: "2+2" } }];
  assert.equal(checkToolArguments(observed, "calculator", { expression: "string" }).pass, true);
  assert.equal(checkToolArguments(observed, "calculator", { left_operand: "number" }).pass, false);
  assert.equal(checkToolArguments(observed, "calculator", { expression: "number" }).pass, false);
});

test("checkToolResultGrounding: reports unverified, not a false pass, when no result evidence exists", () => {
  const observed = [{ name: "web_search", arguments: {} }]; // no result field
  const r = checkToolResultGrounding(observed, "web_search", "some answer");
  assert.equal(r.pass, "unverified");
});

test("checkToolResultGrounding: fails when the final answer ignores the actual tool result", () => {
  const observed = [{ name: "file_search", arguments: {}, result: { chunk: "refunds take 5-7 business days" } }];
  const grounded = checkToolResultGrounding(observed, "file_search", "Based on the file_search result, refunds take 5-7 business days.");
  assert.equal(grounded.pass, true);
  const ungrounded = checkToolResultGrounding(observed, "file_search", "Refunds are instant, no waiting period.");
  assert.equal(ungrounded.pass, false);
});

test("checkFailureRecovery: passes an honest failure report, fails a fabricated confident answer", () => {
  const failedCall = [{ name: "web_search", arguments: {}, error: { message: "HTTP 500" } }];
  const honest = checkFailureRecovery("I'm unable to complete this — the web_search call failed (HTTP 500).", failedCall);
  assert.equal(honest.pass, true);
  const fabricated = checkFailureRecovery("The result is confirmed and ready.", failedCall);
  assert.equal(fabricated.pass, false);
});

test("checkFailureRecovery: fails (with a reason) when no failure is actually present in the trace to recover from", () => {
  const r = checkFailureRecovery("anything", []);
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /no.*failure/i);
});

test("checkTermination: flags a repeated identical call as a possible loop", () => {
  const clean = [{ name: "web_search", arguments: { query: "a" } }];
  assert.equal(checkTermination(clean).pass, true);
  const looping = [
    { name: "web_search", arguments: { query: "a" } },
    { name: "web_search", arguments: { query: "a" } },
    { name: "web_search", arguments: { query: "a" } },
  ];
  assert.equal(checkTermination(looping).pass, false);
});
