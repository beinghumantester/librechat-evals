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
   * BLOCKED instead of silently grading against evidence that isn't really there. */
  evidenceGradeRequired?: EvidenceGrade[];
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
}

// --- Grading ---

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
  reasons: string[];
  nonExecutionReason?: string;
  trace?: {
    toolCalls: ToolCall[];
    finalAnswer: string;
  };
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  totalCases: number;
  byVerdict: Record<GradeVerdict, number>;
  anthropicApiCalls: number;
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
  results: GradeResult[];
}
