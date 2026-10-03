// Executable proof of the invariant documented on EvalCase.expectedVerdict in types.ts:
// the label is an oracle for validating the EVALUATOR, and must never influence grading
// itself. Rather than just asserting that from reading grader.ts's control flow, this runs
// the SAME case under several different expectedVerdict values (including none at all) and
// checks that the independently-computed verdict never changes.
//
// Unlike every other file in tests/, this ONE needs the mock server running (it exercises
// gradeCase() end to end, which makes a real HTTP call) — everything else in this project's
// test suite is deliberately network-free. Rather than making `npm test` hard-fail when the
// mock server isn't up, this probes for it first and skips with a clear message, the same
// "honest non-result, not a failure" discipline the harness itself uses for BLOCKED. CI runs
// this for real (not skipped) as an extra `npm test` step after the mock server is already up
// for the deterministic tier — see .github/workflows/evals.yml.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCase } from "../scripts/lib/grader.js";
import { baseUrl } from "../scripts/lib/librechat-client.js";
import type { UsageAccumulator } from "../scripts/lib/anthropic-client.js";
import type { EvalCase, GradeVerdict } from "../scripts/lib/types.js";

async function mockServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/api/agents/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "eval", messages: [{ role: "user", content: "ping" }] }),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

function baseCase(expectedVerdict?: GradeVerdict): EvalCase {
  return {
    id: "LABEL-INDEPENDENCE-CHECK",
    category: "tool_selection",
    description: "Invariant check, not a real eval case — never loaded via evals/*/cases.json.",
    input: "What is LibreChat, based on current public information?",
    precondition: { endpoint: "agents_v1_chat_completions", mockToolTraceMode: "structured" },
    expectedTool: "web_search",
    evaluationMethod: "deterministic",
    severity: "low",
    ...(expectedVerdict !== undefined ? { expectedVerdict } : {}),
  };
}

test("expectedVerdict never influences the computed verdict (label-independence invariant)", async (t) => {
  if (!(await mockServerReachable())) {
    t.skip("mock-server is not running — start it with `npm run mock-server` to exercise this invariant for real");
    return;
  }

  const usage: UsageAccumulator = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const asPass = await gradeCase(baseCase("PASS"), usage);
  const asFail = await gradeCase(baseCase("FAIL"), usage);
  const asBlocked = await gradeCase(baseCase("BLOCKED"), usage);
  const asUnlabeled = await gradeCase(baseCase(undefined), usage);

  assert.equal(asPass.verdict, asFail.verdict, "labeling the SAME case FAIL instead of PASS must not change the computed verdict");
  assert.equal(asPass.verdict, asBlocked.verdict, "labeling the SAME case BLOCKED must not change the computed verdict either");
  assert.equal(asPass.verdict, asUnlabeled.verdict, "having no label at all must not change the computed verdict");
  assert.deepEqual(asPass.reasons, asFail.reasons, "the reasons behind the verdict must also be identical, not just the verdict string");

  // And labelMatch itself must reflect each label correctly, precisely BECAUSE the verdict
  // it's compared against was independently and identically computed every time above.
  assert.equal(asPass.labelMatch, asPass.verdict === "PASS");
  assert.equal(asFail.labelMatch, asFail.verdict === "FAIL");
  assert.equal(asUnlabeled.labelMatch, undefined, "no label means labelMatch has nothing to compare against");
});
