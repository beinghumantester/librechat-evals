// The ONLY module in this harness that talks to the network. Every other
// module goes through here, the same discipline camelid-client.ts uses in
// the companion project — so swapping the mock server for a real LibreChat
// instance is a one-file change (plus LIBRECHAT_BASE_URL / LIBRECHAT_TOKEN).
//
// Both endpoints used here are real and documented, not invented:
//   POST /api/agents/v1/chat/completions        (OpenAI-compatible surface)
//   POST /api/agents/chat
//   GET  /api/agents/chat/stream/:streamId       (SSE)
// See README.md's "Grounding" section for citations.

import type { ChatCompletionRequest, ChatCompletionResponse, SseEvent } from "./types.js";

const BASE_URL = process.env.LIBRECHAT_BASE_URL ?? "http://127.0.0.1:3080";
const TOKEN = process.env.LIBRECHAT_TOKEN;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) h["authorization"] = `Bearer ${TOKEN}`;
  return h;
}

export function baseUrl(): string {
  return BASE_URL;
}

export interface RawChatResult {
  status: number;
  body: ChatCompletionResponse | undefined;
  raw: string;
}

/**
 * POST /api/agents/v1/chat/completions — the documented OpenAI-compatible surface. Used for
 * every case whose precondition.endpoint is "agents_v1_chat_completions".
 *
 * `mockDirectives` (optional) travels as an `x-mock-directives` header, never as a body
 * field — so the request body sent to a real LibreChat instance is exactly what a real
 * client would send. A real server harmlessly ignores an unrecognized header; only
 * mock-server/server.ts reads it, to decide which tool-trace grade / failure mode / answer
 * to simulate for THIS case, on the one shared long-lived mock process. Never send this
 * against a real instance for anything other than "no directives" — you cannot instruct a
 * real LibreChat deployment to hallucinate or fail a tool call this way; use the real
 * failure-injection points instead (see LIBRECHAT_EVAL_PLAN.md's Phase 0 injection table).
 */
export async function chatCompletion(req: ChatCompletionRequest, mockDirectives?: Record<string, unknown>): Promise<RawChatResult> {
  const headers = authHeaders();
  // HTTP header VALUES must be Latin-1/ByteString — a raw JSON.stringify() breaks the moment
  // a case's mockForceAnswer contains a non-ASCII character (an em dash, a curly quote, ...),
  // which surfaced as a real bug during verification (LC-023/LC-024 threw at fetch() time).
  // encodeURIComponent keeps the header ASCII-only without truncating or mangling the content;
  // mock-server/server.ts decodes it back with a matching decodeURIComponent.
  if (mockDirectives) headers["x-mock-directives"] = encodeURIComponent(JSON.stringify(mockDirectives));
  const res = await fetch(`${BASE_URL}/api/agents/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...req, stream: false }),
  });
  const raw = await res.text();
  let body: ChatCompletionResponse | undefined;
  try {
    body = JSON.parse(raw);
  } catch {
    // Non-JSON response — caller must handle body === undefined rather than this throwing,
    // since "the response wasn't even JSON" is itself a real, gradeable outcome (grade D / ERROR).
  }
  return { status: res.status, body, raw };
}

/**
 * The native flow: POST /api/agents/chat to start a job, then GET
 * /api/agents/chat/stream/:streamId and collect every SSE event verbatim.
 * This is the path Phase 0's central experiment runs against (see
 * LIBRECHAT_EVAL_PLAN.md) — it exists so the evidence-grade classifier gets
 * raw, unmodified events, not a pre-digested summary this client invents.
 */
export async function chatViaNativeSse(conversationId: string, agentId: string, message: string): Promise<SseEvent[]> {
  const start = await fetch(`${BASE_URL}/api/agents/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ conversationId, agentId, message }),
  });
  const startRaw = await start.text();
  let startBody: any = {};
  try {
    startBody = JSON.parse(startRaw);
  } catch {
    throw new Error(`POST /api/agents/chat did not return JSON — raw: ${startRaw.slice(0, 300)}`);
  }
  const streamId = startBody.streamId;
  if (!streamId) {
    throw new Error(`POST /api/agents/chat did not return a streamId — raw: ${startRaw.slice(0, 300)}`);
  }

  const streamRes = await fetch(`${BASE_URL}/api/agents/chat/stream/${streamId}`, { headers: authHeaders() });
  const reader = streamRes.body?.getReader();
  if (!reader) throw new Error("No readable stream returned from GET /api/agents/chat/stream/:streamId");

  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const rawEvent = dataLine.slice(5).trim();
      if (rawEvent === "[DONE]") continue;
      try {
        const parsed = JSON.parse(rawEvent);
        events.push({ type: parsed.type ?? "content", data: parsed });
      } catch {
        events.push({ type: "content", data: rawEvent });
      }
    }
  }
  return events;
}
