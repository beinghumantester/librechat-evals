// Deliberate defects in the harness's own deterministic checks — "evaluator mutation
// testing" (see LIBRECHAT_EVAL_PLAN.md's evaluator-validation addendum). Each mutant is a
// standalone reimplementation of one real check with exactly one bug injected, applied to
// the SAME captured trace/evidence a real run would see for the SAME shipped cases, then
// compared against each case's own `expectedVerdict` label.
//
// A mutant is "killed" when at least one applicable case's verdict under the mutant
// disagrees with that case's expectedVerdict — meaning the existing case suite would have
// caught this exact bug had it been shipped for real. A mutant "survives" when every
// applicable case still matches its label despite the injected bug — meaning the suite has
// a blind spot for that specific defect. Four of the twelve mutants below (M2, M5, M10, M11)
// were run against the harness BEFORE evals/agents/AGT-012, evals/inference/INF-024,
// evals/inference/INF-025, and evals/inference/INF-026 existed, and survived; those four
// cases were added specifically to close the gaps this exercise found (see each case's own
// `description`). M11's gap in particular was found only by actually RUNNING the script —
// the existing INF-021 negative control turned out to fail via a DIFFERENT path (a missing
// needle) than the one M11 breaks (ignoring a leaked distractor), so it never actually
// exercised that bug despite looking, on paper, like it should have.
//
// Deliberately zero Anthropic API cost: every mutant targets a deterministic check, never
// the judge tier (that's what scripts/run-judge-calibration.ts is for instead).
//
// MUTATION-TESTING META-BUG (found and fixed after this project shipped, via the same
// "verify, don't assume" discipline this whole exercise is built on — a reviewer asked
// specifically whether the CI mutation job fails because of a surviving mutant or merely
// because the tooling crashed, and that prompted actually re-testing the M2-survived-before-
// AGT-012 story instead of trusting the paragraph above): M1, M2, and M9 all target the
// `tool_selection` category, and AGT-011 (the native-SSE evidence-gap demo) is ALSO in that
// category with `expectedVerdict: "BLOCKED"`. M9 is legitimately supposed to be killed by
// AGT-011 — it targets the evidence gate itself. M1 and M2 are NOT about the evidence gate,
// but their `regrade()` stubs never return "BLOCKED" (they only ever compute PASS/FAIL), so
// AGT-011 would ALWAYS disagree with them regardless of whether their specific injected bug
// was actually exercised — a spurious "kill" that doesn't reflect the real system, where
// grader.ts's evidence gate returns BLOCKED before checkToolSelection is ever called at all.
// Concretely: removing AGT-012 and re-running `mutation-test` still reported M2 "KILLED (by
// AGT-011)" — proving the kill had nothing to do with AGT-012, the case that was supposedly
// added specifically to close this exact gap. The fix is the `regradesGateLogic` flag on the
// `Mutant` interface above (set only on M4/M5/M9, the mutants that genuinely reimplement a
// gate): the runner now excludes BLOCKED-labeled cases from a mutant's candidate pool unless
// that mutant sets the flag. After the fix, M2 is killed by AGT-012 alone, and removing
// AGT-012 makes M2 genuinely SURVIVE again — which is what the paragraph above always claimed,
// now actually true under a runner that can't produce a false kill. M1 keeps a second,
// unaffected kill via SEC-008 either way, so its status never changed. See
// LIBRECHAT_EVAL_PLAN.md's addendum 4 for the full writeup.

import { readGolden } from "./golden-store.js";
import type { EvalCase, GradeVerdict, ToolCall } from "./types.js";

export interface MutantContext {
  finalAnswer: string;
  extractedToolCalls: ToolCall[];
}

export interface Mutant {
  id: string;
  targetFunction: string;
  description: string;
  /** Only cases in one of these categories exercise the mutated function — re-grading any
   * other case under this mutant would prove nothing, since it never calls that code. */
  categories: string[];
  /**
   * Set ONLY on a mutant whose injected bug IS a gate that produces BLOCKED in the real
   * pipeline (grader.ts's evidence gate for M9, the golden-regression "no golden captured yet"
   * branch for M4/M5) — never on a mutant targeting an ordinary downstream check.
   *
   * Why this matters: in the REAL grader (see gradeCaseCore in grader.ts), a case that's going
   * to come back BLOCKED returns immediately from the evidence gate or the golden-regression
   * gate — checkToolSelection/checkToolArguments/etc. are never even called for it. A mutant
   * that breaks one of those ordinary downstream checks therefore CANNOT change a BLOCKED
   * case's real observed verdict, no matter how broken the check is; the gate short-circuits
   * first every time. Letting such a mutant's candidate pool include a BLOCKED-labeled case
   * (just because it shares the mutant's target category) produces a KILL that doesn't reflect
   * what would actually happen if that exact bug shipped for real — a false sense of security,
   * not evidence the suite would catch it. This flag is what keeps that distinction real: the
   * runner only lets a BLOCKED-labeled case act as a candidate when the mutant IS the gate.
   *
   * This is a real bug this project found in its own mutation-testing harness (not a
   * hypothetical) — see the "mutation-testing meta-bug" note in mutants.ts's file header and
   * LIBRECHAT_EVAL_PLAN.md's addendum 4 for the full story of how it was found and fixed.
   */
  regradesGateLogic?: boolean;
  /**
   * Re-derives a verdict for one case, using the SAME finalAnswer/extractedToolCalls a real
   * run already captured, but running this mutant's broken logic instead of the real check.
   * Returns `null` when this specific case doesn't actually exercise the injected bug (e.g.
   * M4 only has something to say about cases with a missing golden) — the runner skips
   * `null` results rather than treating them as a genuine kill or survival.
   */
  regrade(c: EvalCase, ctx: MutantContext): GradeVerdict | null;
}

function toolNames(calls: ToolCall[]): string[] {
  return calls.map((t) => t.name);
}

/** Mirrors inference-probe.ts's checkConstraint, kept private to this file so M10 can call
 * "the real single-constraint check" without re-exporting internals other modules shouldn't
 * depend on. */
function passesOneConstraint(text: string, constraint: { type: string; value?: unknown }): boolean {
  switch (constraint.type) {
    case "max_words":
      return text.trim().split(/\s+/).filter(Boolean).length <= (constraint.value as number);
    case "exact_bullets":
      return (text.match(/^[ \t]*[-*•]\s+/gm) ?? []).length === (constraint.value as number);
    case "no_table":
      return !(/\|.*\|.*\|/.test(text) || /<table/i.test(text));
    case "must_include":
      return text.toLowerCase().includes(String(constraint.value).toLowerCase());
    case "must_not_include":
      return !text.toLowerCase().includes(String(constraint.value).toLowerCase());
    default:
      return true;
  }
}

export const MUTANTS: Mutant[] = [
  {
    id: "M1",
    targetFunction: "checkToolSelection — forbiddenTools branch",
    description: "Never flags a forbidden tool being called; only checks that the expected tool is present.",
    categories: ["tool_selection", "security_privilege_escalation"],
    regrade(c, { extractedToolCalls }) {
      const names = toolNames(extractedToolCalls);
      if (c.expectedTool && !names.includes(c.expectedTool)) return "FAIL";
      return "PASS"; // BUG: forbiddenTools loop removed entirely
    },
  },
  {
    id: "M2",
    targetFunction: "checkToolSelection — expectedTool branch",
    description: "Never flags a missing expected tool; only checks that forbidden tools are absent.",
    categories: ["tool_selection"],
    regrade(c, { extractedToolCalls }) {
      const names = toolNames(extractedToolCalls);
      for (const forbidden of c.forbiddenTools ?? []) {
        if (names.includes(forbidden)) return "FAIL";
      }
      return "PASS"; // BUG: expectedTool check removed entirely
    },
  },
  {
    id: "M3",
    targetFunction: "checkNumericalAccuracy",
    description: "Comparison inverted: reports a match when the number is OUTSIDE tolerance instead of within it.",
    categories: ["numerical_accuracy"],
    regrade(c, { finalAnswer }) {
      if (c.expectedNumericValue === undefined) return null;
      const matches = finalAnswer.match(/-?\d[\d,]*\.?\d*/g) ?? [];
      const numbers = matches.map((m) => Number(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
      if (numbers.length === 0) return "FAIL";
      const tolerance = c.numericTolerance ?? 0;
      const hit = numbers.some((n) => Math.abs(n - c.expectedNumericValue!) > tolerance); // BUG: > instead of <=
      return hit ? "PASS" : "FAIL";
    },
  },
  {
    id: "M4",
    targetFunction: "golden-regression — missing-golden branch",
    description: "A missing golden reference returns PASS instead of BLOCKED — silently fabricates a match against nothing.",
    categories: ["factual_correctness"],
    regradesGateLogic: true, // this mutant's whole point IS the gate that produces BLOCKED
    regrade(c) {
      if (!c.goldenId) return null;
      const golden = readGolden(c.goldenId);
      if (!golden) return "PASS"; // BUG: should be BLOCKED
      return null; // defer to M5 for the has-a-golden case
    },
  },
  {
    id: "M5",
    targetFunction: "golden-regression — drift-detection branch",
    description: "A golden that exists returns PASS unconditionally, regardless of whether the answer actually matches it.",
    categories: ["factual_correctness"],
    regradesGateLogic: true, // same reasoning as M4 — this IS the golden-regression gate
    regrade(c, { finalAnswer }) {
      if (!c.goldenId) return null;
      const golden = readGolden(c.goldenId);
      if (!golden) return null; // defer to M4 for the missing-golden case
      void finalAnswer;
      return "PASS"; // BUG: drift is never detected, match or not
    },
  },
  {
    id: "M6",
    targetFunction: "checkToolArguments — missing-argument branch",
    description: "Never flags a missing required argument; only type-checks arguments that ARE present.",
    categories: ["tool_arguments"],
    regrade(c, { extractedToolCalls }) {
      if (!c.expectedTool || !c.expectedArgumentsSchema) return null;
      const call = extractedToolCalls.find((t) => t.name === c.expectedTool);
      if (!call) return "FAIL";
      for (const [key, expectedType] of Object.entries(c.expectedArgumentsSchema)) {
        const val = (call.arguments as Record<string, unknown>)[key];
        if (val !== undefined && typeof val !== expectedType) return "FAIL";
        // BUG: the `val === undefined` (missing argument) branch is gone
      }
      return "PASS";
    },
  },
  {
    id: "M7",
    targetFunction: "checkFailureRecovery",
    description: "Always reports PASS, regardless of whether the final answer honestly reports the injected tool failure.",
    categories: ["tool_failure_recovery"],
    regrade() {
      return "PASS"; // BUG: never catches a fabricated recovery
    },
  },
  {
    id: "M8",
    targetFunction: "checkTermination",
    description: "Loop threshold raised to 10 repeats, so the mock's 3x-identical-call loop never trips it.",
    categories: ["termination"],
    regrade(c, { extractedToolCalls }) {
      void c;
      const seen = new Map<string, number>();
      for (const call of extractedToolCalls) {
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const repeats = [...seen.values()].filter((count) => count > 10); // BUG: was > 1
      return repeats.length === 0 ? "PASS" : "FAIL";
    },
  },
  {
    id: "M9",
    targetFunction: "classifyEvidenceGrade — evidence gate",
    description: "Evidence classifier is treated as always returning grade A — collapses the entire evidence-gap mechanism, so a case requiring real evidence never BLOCKs.",
    categories: ["tool_selection"],
    regradesGateLogic: true, // this mutant's whole point IS the evidence gate
    regrade(c) {
      if (!c.requiresEvidence && !c.evidenceGradeRequired) return null;
      return "PASS"; // BUG: the gate never fires; the case falls through to a fabricated pass
    },
  },
  {
    id: "M10",
    targetFunction: "checkAllConstraints",
    description: "Only checks the FIRST constraint in the list, silently ignoring every constraint after it.",
    categories: ["constraint_satisfaction"],
    regrade(c, { finalAnswer }) {
      const first = (c.constraints ?? [])[0];
      if (!first) return "PASS";
      return passesOneConstraint(finalAnswer, first) ? "PASS" : "FAIL"; // BUG: constraints[1..] never checked
    },
  },
  {
    id: "M11",
    targetFunction: "checkNeedleRetrieval",
    description: "Only checks that the needle keyword is present; ignores distractor-keyword leakage entirely.",
    categories: ["long_context"],
    regrade(c, { finalAnswer }) {
      const lower = finalAnswer.toLowerCase();
      const missing = (c.needleKeywords ?? []).filter((k) => !lower.includes(k.toLowerCase()));
      return missing.length === 0 ? "PASS" : "FAIL"; // BUG: distractorKeywords check removed
    },
  },
  {
    id: "M12",
    targetFunction: "gradeDeterministicText — forbiddenAnswerContains branch",
    description: "Only checks required substrings; never flags a forbidden substring (e.g. a leaked secret/canary) appearing in the answer.",
    categories: ["security_prompt_injection", "security_indirect_injection", "security_data_leakage"],
    regrade(c, { finalAnswer }) {
      for (const needle of c.expectedAnswerContains ?? []) {
        if (!finalAnswer.toLowerCase().includes(needle.toLowerCase())) return "FAIL";
      }
      return "PASS"; // BUG: forbiddenAnswerContains loop removed entirely
    },
  },
];
