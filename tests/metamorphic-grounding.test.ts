// One demonstration metamorphic test, per LIBRECHAT_EVAL_PLAN.md Phase 8's "grounding
// property": any claim attributed to a tool result must actually be supported by that
// result, REGARDLESS of the exact wording used to state it. Phase 8 is deliberately adaptive
// ("start from one observed property, expand only if it reveals something"), not a quota of
// generated cases or a generalized paraphrase-testing framework — this is that one test.
//
// Why this targets the EVALUATOR's checkToolResultGrounding(), not the agent's tool
// selection: the natural reading of "one metamorphic agent test" is paraphrase invariance —
// does the agent still pick the right tool when the same request is reworded? That property
// is untestable against this project's mock right now. mock-server/server.ts decides its
// entire response from the `x-mock-directives` header the harness sends per-case (see its
// file header) — it never reads the request's actual text. Two paraphrased inputs for the
// same case would therefore produce byte-identical mock output automatically, which would
// make an agent-level paraphrase test pass unconditionally and prove nothing. Building that
// test today would be exactly the kind of fabricated-looking positive result this project has
// refused to produce elsewhere (see grader.ts's label-independence discipline and the
// mutation-testing README section on not overclaiming). Real paraphrase invariance for the
// agent is Round 2 P0 reconnaissance work, not something a scripted test double can validate.
//
// What IS genuinely testable against pure functions today, with zero mock/network/API
// dependency: whether the EVALUATOR's own grounding check is itself robust to the tool
// result being restated in different surface forms. That's a legitimate metamorphic property
// of the harness, and running it actually found something — see the second test below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkToolResultGrounding } from "../scripts/lib/probe.js";
import type { ToolCall } from "../scripts/lib/types.js";

test("metamorphic grounding property: a synonym/reordering paraphrase of a tool result is still recognized as grounded", () => {
  const call: ToolCall = {
    id: "1",
    name: "web_search",
    arguments: { query: "LibreChat" },
    result: { top_result: "LibreChat is an open-source AI chat platform supporting multiple model providers, Agents, and MCP." },
  };
  const verbatim = "Based on the web_search result, LibreChat is an open-source AI chat platform supporting multiple model providers, Agents, and MCP.";
  const paraphrased = "LibreChat supports Agents, MCP, and multiple model providers — it is an open-source AI chat platform.";

  const asVerbatim = checkToolResultGrounding([call], "web_search", verbatim);
  const asParaphrased = checkToolResultGrounding([call], "web_search", paraphrased);

  assert.equal(asVerbatim.pass, true, "sanity check: the verbatim restatement must be recognized as grounded");
  assert.equal(
    asParaphrased.pass,
    true,
    "the SAME tool result, reworded with synonyms/reordering but no new or missing facts, should still be recognized as grounded — " +
      "checkToolResultGrounding's term-overlap heuristic (>=50% of the result's distinctive terms present) is tolerant of this kind of paraphrase",
  );
});

test("metamorphic grounding property, VIOLATED: a numeric tool result restated in words is NOT currently recognized as grounded (documented limitation, not a silent gap)", () => {
  // This test asserts the CURRENT, imperfect behavior on purpose — the same "run it and see,
  // don't assume" discipline that found the M11/INF-026 blind spot during mutation testing.
  // It exists so this limitation is a named, tracked fact (visible the moment someone tries
  // to "fix" it and breaks this test) rather than a silent gap nobody wrote down.
  const call: ToolCall = { id: "1", name: "calculator", arguments: { expression: "2345*6789" }, result: { value: 15919605 } };
  const digits = "Based on the calculator result, the answer is 15919605.";
  const words = "I calculated it: fifteen million nine hundred nineteen thousand six hundred five.";

  const asDigits = checkToolResultGrounding([call], "calculator", digits);
  const asWords = checkToolResultGrounding([call], "calculator", words);

  assert.equal(asDigits.pass, true, "sanity check: stating the result as digits must be recognized as grounded");
  assert.equal(
    asWords.pass,
    false,
    "checkToolResultGrounding matches on literal substrings/tokens of the result, so a numeral spelled out in words " +
      "(same fact, different surface form) is NOT currently detected as grounded — a real, narrow limitation of the " +
      "deterministic check, worth knowing about rather than assuming digit-vs-words is always covered. " +
      "If this assertion ever needs to flip to `true`, the check itself must have changed to add number-word " +
      "normalization — that's a deliberate improvement to make, not this test silently going stale.",
  );
});
