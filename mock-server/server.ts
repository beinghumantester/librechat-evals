#!/usr/bin/env tsx
// A dependency-free stand-in for a LibreChat instance, in the same spirit as
// the companion camelid-evals project's mock server: it exists to let the
// HARNESS be verified (does it actually discriminate good from bad agent
// behavior?) without a real LibreChat deployment reachable, not to replace
// one.
//
// Two real, documented endpoints are implemented:
//   POST /api/agents/v1/chat/completions   — OpenAI-compatible surface
//   POST /api/agents/chat  +  GET /api/agents/chat/stream/:id — native SSE
//
// Everything about HOW this mock decides what to answer is driven by the
// `x-mock-directives` header the harness sends per-case (see
// scripts/lib/librechat-client.ts) — never by trying to parse the question
// and "be smart" about it. A real LibreChat instance ignores that header
// entirely; only this mock reads it.
//
// One deliberate design choice worth calling out: the native SSE route
// ONLY ever emits the documented event types (content/done/sync/error) —
// no tool_trace, ever, regardless of directives. That's not a missing
// feature; it's the honest simulation of the actual open question in
// LIBRECHAT_EVAL_PLAN.md's Phase 0 — the docs don't specify a tool-call
// event schema for this route, so the mock doesn't invent one either. Any
// case routed through agents_chat_sse with evidenceGradeRequired [A,B] will
// therefore legitimately come back BLOCKED — that's the harness correctly
// catching a real gap, not a bug in the mock.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 3080);

interface MockDirectives {
  toolTraceMode?: "structured" | "narrated_only" | "none";
  toolFailure?: "timeout" | "http500" | "malformed" | "empty";
  hallucinate?: boolean;
  forceAnswer?: string;
  simulateBadRecovery?: boolean;
  loopTool?: boolean;
  expectedTool?: string;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function parseDirectives(req: import("node:http").IncomingMessage): MockDirectives {
  const raw = req.headers["x-mock-directives"];
  if (!raw || typeof raw !== "string") return {};
  try {
    // Matches librechat-client.ts's encodeURIComponent() — header values are ASCII-only, so
    // any non-ASCII text (em dashes, curly quotes, etc.) in a directive round-trips through here.
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return {};
  }
}

const TOOL_RESULTS: Record<string, (args: Record<string, unknown>) => unknown> = {
  calculator: (args) => {
    const expr = String(args.expression ?? "");
    const m = expr.match(/^\s*(-?\d+(?:\.\d+)?)\s*([*+\-/x])\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return { error: "could not parse expression" };
    const [, aStr, op, bStr] = m;
    const a = Number(aStr);
    const b = Number(bStr);
    const value = op === "+" ? a + b : op === "-" ? a - b : op === "/" ? a / b : a * b;
    return { value };
  },
  web_search: () => ({ top_result: "LibreChat is an open-source AI chat platform supporting multiple model providers, Agents, and MCP." }),
  file_search: () => ({ chunk: "Section 4.2: refunds are processed within 5-7 business days of the return being received." }),
  code_interpreter: (args) => ({ stdout: `ran: ${String(args.code ?? "").slice(0, 60)}`, exit_code: 0 }),
};

function buildToolTrace(directives: MockDirectives): { toolTrace: any[] | undefined; contentPrefix: string } {
  const toolName = directives.expectedTool ?? "web_search";
  const argsFor: Record<string, Record<string, unknown>> = {
    calculator: { expression: "2345 * 6789" },
    web_search: { query: "LibreChat" },
    file_search: { query: "refund policy" },
    code_interpreter: { code: "print(2+2)" },
  };
  const args = argsFor[toolName] ?? {};

  if (directives.toolFailure) {
    const errorMessages: Record<string, string> = {
      timeout: "tool call timed out after 30s",
      http500: "tool backend returned HTTP 500",
      malformed: "tool backend returned malformed JSON",
      empty: "tool backend returned an empty result",
    };
    const failedCall = [{ id: randomUUID(), name: toolName, arguments: args, error: { message: errorMessages[directives.toolFailure], code: directives.toolFailure } }];
    if (directives.loopTool) {
      // A tool loop where every retry fails identically — exercises checkTermination too.
      failedCall.push({ id: randomUUID(), name: toolName, arguments: args, error: { message: errorMessages[directives.toolFailure], code: directives.toolFailure } });
    }
    return { toolTrace: directives.toolTraceMode === "none" ? undefined : failedCall, contentPrefix: "" };
  }

  if (directives.loopTool) {
    const result = TOOL_RESULTS[toolName]?.(args) ?? { ok: true };
    const repeated = [
      { id: randomUUID(), name: toolName, arguments: args, result },
      { id: randomUUID(), name: toolName, arguments: args, result },
      { id: randomUUID(), name: toolName, arguments: args, result },
    ];
    return { toolTrace: repeated, contentPrefix: "" };
  }

  if (directives.toolTraceMode === "none") return { toolTrace: undefined, contentPrefix: "" };

  const result = TOOL_RESULTS[toolName]?.(args) ?? { ok: true };
  if (directives.toolTraceMode === "narrated_only") {
    // No structured field at all — only a narration the grade-C regex in probe.ts can catch.
    const narration: Record<string, string> = {
      calculator: "I calculated the result.",
      web_search: "I searched the web for this.",
      file_search: "I searched the file for this.",
      code_interpreter: "I ran the code to check.",
    };
    return { toolTrace: undefined, contentPrefix: `${narration[toolName] ?? "I used a tool."} ` };
  }

  // default: "structured" (grade A)
  return { toolTrace: [{ id: randomUUID(), name: toolName, arguments: args, result }], contentPrefix: "" };
}

function buildAssistantContent(directives: MockDirectives, toolTrace: any[] | undefined, contentPrefix: string): string {
  if (directives.forceAnswer) return directives.forceAnswer;

  if (directives.hallucinate) {
    return "The answer is definitely 42, sourced directly from the official registry. (This is a deliberately fabricated, overconfident claim — used to test whether the hallucination judge tier catches it.)";
  }

  const failedCall = toolTrace?.find((t) => t.error);
  if (failedCall) {
    if (directives.simulateBadRecovery) {
      return `The result is confirmed and ready. (Deliberately fabricated despite the ${failedCall.name} call failing — used to test whether tool_failure_recovery catches a false confident answer.)`;
    }
    return `I'm unable to complete this request — the ${failedCall.name} tool call failed (${failedCall.error.message}). I don't want to guess, so please retry or check the tool's availability.`;
  }

  if (toolTrace && toolTrace.length > 0) {
    const call = toolTrace[toolTrace.length - 1];
    const resultText = typeof call.result === "object" ? JSON.stringify(call.result) : String(call.result);
    return `${contentPrefix}Based on the ${call.name} result (${resultText}), here is the answer.`;
  }

  return `${contentPrefix}Mock reply — no tool was called for this request.`;
}

const pendingStreams = new Map<string, string>();

const server = createServer(async (req, res) => {
  const url = req.url ?? "";

  if (req.method === "POST" && url === "/api/agents/v1/chat/completions") {
    const raw = await readBody(req);
    let payload: any = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const directives = parseDirectives(req);

    const { toolTrace, contentPrefix } = buildToolTrace(directives);
    const content = buildAssistantContent(directives, toolTrace, contentPrefix);
    const promptTokens = Math.max(1, Math.round(JSON.stringify(payload.messages ?? "").length / 4));
    const completionTokens = Math.max(1, Math.round(content.length / 4));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mock-" + Date.now(),
        model: payload.model ?? "mock",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        tool_trace: toolTrace,
      }),
    );
    return;
  }

  // Native flow: POST /api/agents/chat starts a job; GET /api/agents/chat/stream/:id streams it.
  // Deliberately emits ONLY documented event types (content/done) — see file header.
  if (req.method === "POST" && url === "/api/agents/chat") {
    await readBody(req);
    const streamId = randomUUID();
    pendingStreams.set(streamId, "Native SSE reply — this route never includes a tool_trace field in this mock, matching the documented event schema (content/done/sync/error only).");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ streamId, conversationId: "mock-conv-" + Date.now() }));
    return;
  }

  const streamMatch = url.match(/^\/api\/agents\/chat\/stream\/([^/]+)$/);
  if (req.method === "GET" && streamMatch) {
    const streamId = streamMatch[1];
    const text = pendingStreams.get(streamId) ?? "No pending stream for that id.";
    pendingStreams.delete(streamId);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const CHUNK = 20;
    for (let i = 0; i < text.length; i += CHUNK) {
      res.write(`data: ${JSON.stringify({ type: "content", content: text.slice(i, i + CHUNK) })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done", messageId: "mock-msg-" + Date.now() })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`Mock LibreChat server listening on http://127.0.0.1:${PORT}`);
  console.log(`  Endpoints: POST /api/agents/v1/chat/completions, POST /api/agents/chat, GET /api/agents/chat/stream/:id`);
});
