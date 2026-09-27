// Deterministic AGENT-TRACE checks (tool selection/arguments/grounding/
// failure-recovery/termination) plus the evidence-grade classifier. Pure
// inference checks (constraints, numerical accuracy, long-context
// retrieval) live in inference-probe.ts instead — this project used to
// lump everything into one probe.ts; splitting it is part of giving
// inference its own first-class home rather than a few functions bolted
// onto the agent module.
//
// classifyEvidenceGrade() is the single most important function in this
// harness: it turns Phase 0's central open question ("does LibreChat expose
// tool name/arguments/result, or only narrate them in text?") into code that
// runs on every case, instead of a one-time manual check that gets
// forgotten. It NEVER assumes a field exists — it inspects the actual
// response and reports what it found.

import type { ChatCompletionResponse, EvidenceGrade, ToolCall } from "./types.js";

export function classifyEvidenceGrade(
  response: ChatCompletionResponse,
  finalAnswerText: string,
): { grade: EvidenceGrade; extractedToolCalls: ToolCall[] } {
  // Grade A: a structured trace with name + arguments (+ optionally result) is present.
  if (response.tool_trace && response.tool_trace.length > 0) {
    return { grade: "A", extractedToolCalls: response.tool_trace };
  }

  const msg = response.choices?.[0]?.message;
  if (msg?.tool_calls && msg.tool_calls.length > 0) {
    const extracted: ToolCall[] = msg.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? "unknown",
      arguments: safeParseArgs(tc.function?.arguments),
    }));
    // OpenAI-shaped tool_calls give name + arguments but not necessarily the RESULT.
    // That distinction matters: it's enough for tool_selection / tool_arguments checks,
    // but a grounding check (does the final answer match what the tool actually
    // returned) needs the result too — checkToolResultGrounding() below reports
    // UNVERIFIED, not a false PASS, when result is missing.
    return { grade: "A", extractedToolCalls: extracted };
  }

  // Grade C: no structured field anywhere, but the final text narrates tool use in a
  // pattern a regex can pick up. This is deliberately narrow — it should not be treated
  // as reliable evidence of *which* tool ran or with *what* arguments, only that grade A/B
  // evidence is absent and grade C is the best available.
  const narrated = extractNarratedToolMention(finalAnswerText);
  if (narrated) {
    return { grade: "C", extractedToolCalls: [{ name: narrated, arguments: {} }] };
  }

  return { grade: "D", extractedToolCalls: [] };
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const NARRATION_PATTERNS: Array<{ pattern: RegExp; tool: string }> = [
  { pattern: /\b(searched|searching) the web\b/i, tool: "web_search" },
  { pattern: /\b(ran|running|executed|executing) (the )?code\b/i, tool: "code_interpreter" },
  { pattern: /\bsearch(ed|ing)? (the )?(file|document|knowledge base)s?\b/i, tool: "file_search" },
  { pattern: /\bcalculat(ed|ing)\b/i, tool: "calculator" },
];

function extractNarratedToolMention(text: string): string | null {
  for (const { pattern, tool } of NARRATION_PATTERNS) {
    if (pattern.test(text)) return tool;
  }
  return null;
}

// --- agent: tool selection / arguments / result grounding (Phase 3 §1-3) ---

export function checkToolSelection(
  observed: ToolCall[],
  expectedTool: string | undefined,
  forbiddenTools: string[] | undefined,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const names = observed.map((t) => t.name);
  if (expectedTool && !names.includes(expectedTool)) {
    reasons.push(`expected tool '${expectedTool}' to be called; observed: [${names.join(", ") || "none"}]`);
  }
  for (const forbidden of forbiddenTools ?? []) {
    if (names.includes(forbidden)) reasons.push(`forbidden tool '${forbidden}' was called`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function checkToolArguments(
  observed: ToolCall[],
  expectedTool: string,
  schema: Record<string, "string" | "number" | "boolean"> | undefined,
): { pass: boolean; reasons: string[] } {
  if (!schema) return { pass: true, reasons: [] };
  const call = observed.find((t) => t.name === expectedTool);
  if (!call) return { pass: false, reasons: [`no call to '${expectedTool}' found — cannot check its arguments`] };
  const reasons: string[] = [];
  for (const [key, expectedType] of Object.entries(schema)) {
    const val = call.arguments[key];
    if (val === undefined) {
      reasons.push(`missing required argument '${key}'`);
      continue;
    }
    if (typeof val !== expectedType) reasons.push(`argument '${key}' expected ${expectedType}, got ${typeof val}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** A correct tool with a correct call is not the same as a grounded answer — this checks
 * whether the observed tool RESULT (when we have one) is actually reflected in the final
 * text, catching the classic "tool returned X, model said Y" failure. Returns "unverified"
 * (not a false pass) when no result evidence exists to check against. */
export function checkToolResultGrounding(
  observed: ToolCall[],
  expectedTool: string,
  finalAnswerText: string,
): { pass: boolean | "unverified"; reasons: string[] } {
  const call = observed.find((t) => t.name === expectedTool);
  if (!call || call.result === undefined) {
    return { pass: "unverified", reasons: [`no tool RESULT evidence available for '${expectedTool}' — grade A/B trace with a result field is required to check grounding, not just arguments`] };
  }
  const resultText = typeof call.result === "string" ? call.result : JSON.stringify(call.result);
  const grounded = finalAnswerText.includes(resultText) || resultTermsAppearIn(resultText, finalAnswerText);
  return grounded ? { pass: true, reasons: [] } : { pass: false, reasons: [`final answer does not reflect the tool result (${resultText.slice(0, 120)})`] };
}

function resultTermsAppearIn(resultText: string, finalAnswerText: string): boolean {
  const terms = resultText.match(/[A-Za-z0-9][A-Za-z0-9.\-]{2,}/g) ?? [];
  if (terms.length === 0) return false;
  const hits = terms.filter((t) => finalAnswerText.includes(t)).length;
  return hits / terms.length >= 0.5;
}

/** Phase 3 §4: did the agent handle an injected tool failure honestly (report it, don't
 * fabricate a result) rather than silently continuing as if nothing happened? */
export function checkFailureRecovery(finalAnswerText: string, toolCalls: ToolCall[]): { pass: boolean; reasons: string[] } {
  const failedCall = toolCalls.find((t) => t.error);
  if (!failedCall) return { pass: false, reasons: ["expected an injected tool failure to be present in the trace, but none was observed — check the mock's MOCK_TOOL_FAILURE toggle"] };

  const looksLikeFabrication = /^\s*(the (result|answer) is|according to)/i.test(finalAnswerText) && !/(unable|couldn't|failed|error|can't|cannot)/i.test(finalAnswerText);
  const acknowledgesFailure = /(unable|couldn't|failed|error|can't|cannot|not able)/i.test(finalAnswerText);

  if (looksLikeFabrication) {
    return { pass: false, reasons: ["final answer presents a confident result despite an injected tool failure — looks fabricated"] };
  }
  return acknowledgesFailure
    ? { pass: true, reasons: [] }
    : { pass: false, reasons: ["final answer neither acknowledges the failure nor looks fabricated — ambiguous, treated as a failure to report honestly"] };
}

/** Phase 3 §6: crude loop detector — same tool called with identical arguments more than
 * once in a single trace, with no new information between calls. */
export function checkTermination(toolCalls: ToolCall[], maxRepeats = 1): { pass: boolean; reasons: string[] } {
  const seen = new Map<string, number>();
  for (const call of toolCalls) {
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeats = [...seen.entries()].filter(([, count]) => count > maxRepeats);
  return repeats.length === 0
    ? { pass: true, reasons: [] }
    : { pass: false, reasons: repeats.map(([key, count]) => `'${key}' called ${count} times (max ${maxRepeats}) — possible tool loop`) };
}
