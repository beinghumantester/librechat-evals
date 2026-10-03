// Shared types for the LibreChat agent + inference evaluation harness.
//
// Two endpoints are used, both real and documented (see README.md's
// "Grounding" section for citations, and LIBRECHAT_EVAL_PLAN.md's Phase 0):
//   - POST /api/agents/v1/chat/completions   (OpenAI-compatible surface)
//   - POST /api/agents/chat + GET /api/agents/chat/stream/:streamId
//     (native flow; documented SSE event types are content/done/sync/error —
//     NOT a documented tool_calls/tool_result schema. That gap is exactly
//     what classifyEvidenceGrade() in probe.ts exists to test at runtime,
//     never to assume.)

export type EvidenceGrade = "A" | "B" | "C" | "D";
// A = directly observable in the API response / SSE stream, parseable
// B = observable with legitimate instrumentation (server logs, DB read, an
//     admin/export endpoint) — not scraping the rendered UI
// C = only inferable from the final response text
// D = currently inaccessible by any legitimate means

/**
 * A single response is not one piece of evidence — it's several, and each can sit at a
 * different grade. Collapsing everything into one scalar `grade` (as the first version of
 * this harness did) can only ever say "agent evaluation was grade A"; it can't say "tool
 * selection was evaluable but result-grounding wasn't," which is the more honest and more
 * common real answer. `classifyEvidenceGrade()` in probe.ts produces one of these per
 * response, never assuming a field exists — it reports what it actually found.
 *
 * NOTE: this is deliberately still a small, fixed set of fields (not a general
 * EvidenceProvider/adapter framework). That heavier architecture is explicitly NOT built
 * yet — see LIBRECHAT_EVAL_PLAN.md's reconnaissance-first note. Build it later only if real
 * reconnaissance against an actual LibreChat instance shows this fixed set is insufficient.
 */
export type EvidenceField = "toolName" | "toolArguments" | "toolResult" | "toolError" | "termination";
export type EvidenceMap = Record<EvidenceField, EvidenceGrade>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  agentId?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code?: string };
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /**
   * Non-standard field. The mock server populates this when
   * MOCK_TOOL_TRACE_MODE=structured, to give classifyEvidenceGrade() a
   * grade-A payload to detect. Whether a REAL LibreChat instance ever
   * populates something like this (or exposes the same information some
   * other way — a separate endpoint, server logs) is exactly Phase 0's
   * open question. The harness must never assume this field exists on a
   * real instance; it only exists here so the classifier and the mock are
   * both exercised honestly, with the mock clearly labeled as a stand-in.
   */
  tool_trace?: ToolCall[];
}

export type SseEventType = "content" | "done" | "sync" | "error";
export interface SseEvent {
  type: SseEventType;
  data: unknown;
}

// --- Case schema (LIBRECHAT_EVAL_PLAN.md Phase 1) ---

export type EvalCategory =
  // inference — deliberately the largest group; see README's "why inference gets more
  // weight here than in the companion camelid-evals project" section
  | "factual_correctness"
  | "hallucination"
  | "abstention"
  | "instruction_following"
  | "constraint_satisfaction"
  | "consistency"
  | "numerical_accuracy"
  | "long_context"
  // agent
  | "tool_selection"
  | "tool_arguments"
  | "tool_result_grounding"
  | "tool_failure_recovery"
  | "termination"
  // security (Phase 4's full four categories, not just the two this project shipped first)
  | "security_prompt_injection"
  | "security_indirect_injection"
  | "security_data_leakage"
  | "security_privilege_escalation";

export type EvaluationMethod = "deterministic" | "llm_judge";

export type Constraint =
  | { type: "max_words"; value: number }
  | { type: "exact_bullets"; value: number }
  | { type: "no_table"; value?: undefined }
  | { type: "must_include"; value: string }
  | { type: "must_not_include"; value: string };

export interface CasePrecondition {
  endpoint: "agents_v1_chat_completions" | "agents_chat_sse";
  requiredTools?: string[];
  /**
   * Everything below drives the MOCK SERVER's per-request `x-mock-directives` header (see
   * mock-server/server.ts and librechat-client.ts). All of it is undefined/ignored when
   * pointed at a real LibreChat instance — you'd inject the equivalent failure at the real
   * dependency instead (kill the MCP server, revoke a credential, etc.), per
   * LIBRECHAT_EVAL_PLAN.md's Phase 0 injection table.
   */
  mockToolFailure?: "timeout" | "http500" | "malformed" | "empty";
  mockToolTraceMode?: "structured" | "narrated_only" | "none";
  mockHallucinate?: boolean;
  mockForceAnswer?: string;
  mockSimulateBadRecovery?: boolean;
  mockLoopTool?: boolean;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  description: string;
  input: string;
  system?: string;
  precondition: CasePrecondition;
  /** If the evidence grade actually observed at run time isn't in this list, the case reports
   * BLOCKED instead of silently grading against evidence that isn't really there.
   * DEPRECATED in favor of `requiresEvidence` below, which can name WHICH field of the
   * response needs the evidence (tool name vs. arguments vs. result, etc.) instead of only
   * the response as a whole. Still supported and still checked — a case can use either or
   * both; both must be satisfied for the case to proceed past the evidence gate. */
  evidenceGradeRequired?: EvidenceGrade[];
  /** Granular successor to `evidenceGradeRequired`: which EvidenceMap field(s) must be at
   * which grade(s) for this case to be gradable at all. A case can require just the field(s)
   * its own check actually depends on — e.g. tool_result_grounding only truly needs
   * `toolResult`, not the whole response at grade A. If any named field's OBSERVED grade
   * isn't in its allowed list, the case reports BLOCKED with a reason naming exactly which
   * field fell short and what was actually observed instead. */
  requiresEvidence?: Partial<Record<EvidenceField, EvidenceGrade[]>>;
  expectedTool?: string;
  forbiddenTools?: string[];
  expectedArgumentsSchema?: Record<string, "string" | "number" | "boolean">;
  expectedAnswerContains?: string[];
  forbiddenAnswerContains?: string[];
  constraints?: Constraint[];
  /** numerical_accuracy: the code-checkable correct value and an allowed tolerance
   * (0 for exact). Per Phase 2 §7, never judged by an LLM. */
  expectedNumericValue?: number;
  numericTolerance?: number;
  /** long_context: keywords the answer must surface (the needle) and must NOT surface
   * (a distractor standing in for a plausible-but-wrong fact placed elsewhere in the input). */
  needleKeywords?: string[];
  distractorKeywords?: string[];
  /** Pins this case to a captured reference answer (scripts/capture-golden.ts) instead of —
   * or as well as — the checks implied by evaluationMethod. Never fabricated if missing; see
   * scripts/lib/golden-store.ts. */
  goldenId?: string;
  /** Independent of whether the TASK succeeded — see TaskAgentVerdict. */
  expectedAgentBehaviorOnFailure?: "report_honestly" | "retry_then_report" ;
  /** Only used by category "consistency": the input is run once, this is run once more, and
   * the two answers are judged for semantic agreement instead of either being judged alone. */
  pairedInput?: string;
  evaluationMethod: EvaluationMethod;
  judgeExpectations?: string[];
  severity: "low" | "medium" | "high";
  /**
   * Oracle for validating the EVALUATOR, not a claim about the system under test. Every
   * shipped case has one — positive cases are "PASS", negative controls are "FAIL", the two
   * intentional evidence-gap demos are "BLOCKED". This value must never influence grading:
   * grader.ts's gradeCase() only reads it AFTER gradeCaseCore() has independently computed
   * a verdict from the actual request/response, purely to set `labelMatch` — never before,
   * and never as an input to request construction or category dispatch. That invariant is
   * checked directly (not just documented) by tests/label-independence.test.ts, which runs
   * one case under several different expectedVerdict values and asserts the computed
   * verdict never changes.
   *
   * This is what makes two things possible: (1) a self-check on every ordinary run — did
   * every case actually behave the way its own author expected? — surfaced in
   * RunSummary.labelMismatches; and (2) mutation testing (scripts/run-mutation-tests.ts),
   * which re-grades these same cases with a deliberately broken check and calls the mutant
   * "killed" only if some case's observed verdict now disagrees with this label. A case
   * observed as BLOCKED is never counted as a mismatch against its label — BLOCKED means
   * "we didn't get to check", not "we checked and disagreed" (see the GradeVerdict contract
   * below).
   */
  expectedVerdict?: GradeVerdict;
}

// --- Grading ---

/**
 * The evaluator contract. Every verdict below has one fixed meaning, used consistently by
 * every category's grading path — this is what makes mutation testing and the label
 * self-check meaningful at all, because "did the evaluator behave correctly" only has an
 * answer once "correctly" is written down instead of implied case-by-case.
 *
 *   PASS            Evidence was sufficient AND observed behavior satisfies the expectation.
 *   FAIL            Evidence was sufficient AND observed behavior violates the expectation.
 *   BLOCKED         The evaluation could not be PERFORMED at all — required evidence,
 *                   capability, configuration, or credential (e.g. a missing golden
 *                   reference, a missing ANTHROPIC_API_KEY, an evidence grade below what the
 *                   case requires) was unavailable. Never a stand-in for "probably fine" or
 *                   "probably broken" — it means the harness refused to guess.
 *   UNVERIFIED      The scenario DID execute, but the evidence actually available cannot
 *                   establish PASS or FAIL either way (e.g. no tool-result evidence exists
 *                   to check grounding against). Distinct from BLOCKED: the case ran, it
 *                   just can't be scored — a rarer, more specific kind of "we won't guess."
 *   ERROR           The HARNESS itself failed to execute the evaluation (a thrown exception,
 *                   a malformed case) — a defect in the test infrastructure, not a finding
 *                   about the system under test.
 *   NOT_APPLICABLE  The case does not apply to the observed system/configuration at all
 *                   (reserved for future use — e.g. a case gated on a capability the target
 *                   deployment doesn't have configured; not currently produced by any path).
 *
 * BLOCKED and UNVERIFIED must never be allowed to become a dumping ground for every kind of
 * uncertainty — if a new situation doesn't cleanly fit one of the meanings above, that's a
 * sign the contract needs a new, equally explicit case, not that BLOCKED should absorb it.
 */
export type GradeVerdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_APPLICABLE" | "UNVERIFIED" | "ERROR";

/**
 * The central distinction from LIBRECHAT_EVAL_PLAN.md: did the requested TASK succeed, and
 * did the AGENT behave correctly given what was actually available to it — graded
 * independently. A broken tool + an honest "I can't do this" is task=FAIL, agent=PASS.
 */
export interface TaskAgentVerdict {
  task: "PASS" | "FAIL" | "N/A";
  agent: "PASS" | "FAIL" | "N/A";
}

export interface GradeResult {
  id: string;
  category: EvalCategory;
  verdict: GradeVerdict;
  taskAgent?: TaskAgentVerdict;
  observedEvidenceGrade?: EvidenceGrade;
  /** Per-field breakdown backing `observedEvidenceGrade` — see EvidenceMap's doc comment. */
  observedEvidenceMap?: EvidenceMap;
  reasons: string[];
  nonExecutionReason?: string;
  /**
   * Whether this result agrees with the case's own `expectedVerdict` label.
   * `undefined` when the case has no label, OR when the observed verdict is BLOCKED (a
   * non-execution is never scored as a disagreement — see the GradeVerdict contract above).
   * `true`/`false` otherwise. RunSummary.labelMismatches is every result where this is
   * `false` — a case behaving differently than its own author designed it to.
   */
  labelMatch?: boolean;
  trace?: {
    toolCalls: ToolCall[];
    finalAnswer: string;
    /**
     * The normalized response this GradeResult was computed from. For the OpenAI-compatible
     * endpoint this parsed JSON body already IS essentially the raw observation, so nothing
     * is lost. For the native SSE flow, this is `sseEventsToResponse()`'s RECONSTRUCTION —
     * a lossy step by construction (it only extracts `content` text and any `tool_trace` it
     * recognizes) — so `rawResponse` alone is not a substitute for `rawTransport` below when
     * the transport is SSE.
     */
    rawResponse?: unknown;
    /**
     * The untouched observation, for transports where "normalized" and "raw" are NOT the
     * same thing — currently only the native SSE flow, where this is `{ protocol: "sse",
     * events: SseEvent[] }`, the exact event array before `sseEventsToResponse()` touched it.
     * Undefined for the OpenAI-compatible endpoint (rawResponse already covers that case).
     * The reason this exists at all: if a future change to the SSE parser silently drops or
     * misreads an event, `rawResponse` would already reflect that bug — this field is what
     * lets someone later ask "was the evidence actually IN the stream, or did we just fail to
     * parse it?" and get a real answer instead of "we don't know, we didn't keep it."
     * Lightweight replay support, still deliberately NOT a full raw/normalized trace pipeline
     * with versioning and hashing — that's real infrastructure worth building once there's an
     * actual replay need against a real deployment, not before.
     */
    rawTransport?: unknown;
  };
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  totalCases: number;
  byVerdict: Record<GradeVerdict, number>;
  /** Case ids where `labelMatch === false` — the case ran, produced a verdict, and that
   * verdict disagreed with the case's own `expectedVerdict`. This is a self-check on the
   * harness, not a report about LibreChat: every entry here means either the case's label is
   * wrong or a check regressed, and either way it needs a human look before trusting this run. */
  labelMismatches: string[];
  anthropicApiCalls: number;
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
  results: GradeResult[];
}

// --- Evaluator validation (evals/evaluator/) ---
//
// "Judge agreement is not judge accuracy" — the 2-of-3 voting in anthropic-client.ts damps
// single-call flakiness, but three votes can still unanimously agree on the WRONG verdict.
// A JudgeCalibrationCase carries a human-assigned ground-truth label so the judge's own
// accuracy (not just its self-consistency) can be measured — see
// scripts/run-judge-calibration.ts and scripts/lib/judge-calibration.ts.

export interface JudgeCalibrationCase {
  id: string;
  /** "calibration" — an ordinary labeled example spanning obvious/borderline judge
   * decisions across categories. "injection" — the candidate answer itself contains text
   * trying to manipulate the JUDGE (not the agent) into returning PASS regardless of
   * content; humanLabel is always "FAIL" for these, since a legitimate grade must ignore
   * the embedded instruction and judge only the substance. */
  suite: "calibration" | "injection";
  description: string;
  input: string;
  answerText: string;
  judgeExpectations: string[];
  humanLabel: "PASS" | "FAIL";
}
