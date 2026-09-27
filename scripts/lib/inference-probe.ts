// Deterministic INFERENCE checks — split out from probe.ts (which now holds
// only agent-trace checks) so the inference side of this harness has its
// own home, not a few functions bolted onto the agent module. This is
// where the "more focus on inference" expansion actually lives: constraint
// checking (moved here), plus two mechanisms camelid-evals never needed
// because it tested a deterministic local engine, not a chat model's
// natural-language answers — numerical extraction and long-context needle
// retrieval.

import type { Constraint } from "./types.js";

// --- constraint satisfaction / instruction following (Phase 2 §4-5) ---

export function checkConstraint(text: string, constraint: Constraint): { pass: boolean; reason?: string } {
  switch (constraint.type) {
    case "max_words": {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      return words <= constraint.value ? { pass: true } : { pass: false, reason: `response has ${words} words, exceeds max ${constraint.value}` };
    }
    case "exact_bullets": {
      const bullets = (text.match(/^[ \t]*[-*•]\s+/gm) ?? []).length;
      return bullets === constraint.value ? { pass: true } : { pass: false, reason: `found ${bullets} bullet lines, expected exactly ${constraint.value}` };
    }
    case "no_table": {
      const hasTable = /\|.*\|.*\|/.test(text) || /<table/i.test(text);
      return !hasTable ? { pass: true } : { pass: false, reason: "response contains a table, which was forbidden" };
    }
    case "must_include": {
      const ok = text.toLowerCase().includes(constraint.value.toLowerCase());
      return ok ? { pass: true } : { pass: false, reason: `missing required substring '${constraint.value}'` };
    }
    case "must_not_include": {
      const bad = text.toLowerCase().includes(constraint.value.toLowerCase());
      return !bad ? { pass: true } : { pass: false, reason: `contains forbidden substring '${constraint.value}'` };
    }
  }
}

/** Checks EVERY constraint and returns all failures, not just the first — per Phase 2 §5:
 * "measure individual constraints rather than using a vague overall score." */
export function checkAllConstraints(text: string, constraints: Constraint[]): { pass: boolean; reasons: string[] } {
  const failed = constraints.map((c) => ({ c, r: checkConstraint(text, c) })).filter((x) => !x.r.pass);
  return { pass: failed.length === 0, reasons: failed.map((x) => x.r.reason ?? `constraint ${x.c.type} failed`) };
}

// --- numerical accuracy (Phase 2 §7): a program checks the number, never a judge ---

/**
 * Extracts every number the answer text contains and checks whether at least one is within
 * `tolerance` of `expectedValue`. Deliberately permissive about WHERE the number appears
 * (a chat answer usually wraps it in prose) but strict about the VALUE — this is the
 * distinction the plan draws between "don't use an LLM judge for arithmetic" and "don't
 * demand an exact-format match a real model would never produce."
 */
export function checkNumericalAccuracy(answerText: string, expectedValue: number, tolerance = 0): { pass: boolean; reasons: string[] } {
  const matches = answerText.match(/-?\d[\d,]*\.?\d*/g) ?? [];
  const numbers = matches.map((m) => Number(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
  if (numbers.length === 0) {
    return { pass: false, reasons: [`no numeric value found in the answer to compare against expected ${expectedValue}`] };
  }
  const hit = numbers.some((n) => Math.abs(n - expectedValue) <= tolerance);
  return hit
    ? { pass: true, reasons: [] }
    : { pass: false, reasons: [`expected a value within ${tolerance} of ${expectedValue}; found [${numbers.join(", ")}] in the answer`] };
}

// --- long-context retrieval (Phase 2 §8) ---

/**
 * Checks that the answer surfaces the needle fact (by keyword overlap, not exact string —
 * a model will paraphrase) and does NOT surface a distractor fact instead. Both checks are
 * independent: a model can fail by omitting the needle, by reporting a distractor as if it
 * were the needle, or both.
 */
export function checkNeedleRetrieval(
  answerText: string,
  needleKeywords: string[],
  distractorKeywords: string[] = [],
): { pass: boolean; reasons: string[] } {
  const lower = answerText.toLowerCase();
  const reasons: string[] = [];
  const missing = needleKeywords.filter((k) => !lower.includes(k.toLowerCase()));
  if (missing.length > 0) reasons.push(`answer is missing needle keyword(s): ${missing.join(", ")}`);
  const leaked = distractorKeywords.filter((k) => lower.includes(k.toLowerCase()));
  if (leaked.length > 0) reasons.push(`answer surfaces distractor keyword(s) instead of the needle: ${leaked.join(", ")}`);
  return { pass: reasons.length === 0, reasons };
}
