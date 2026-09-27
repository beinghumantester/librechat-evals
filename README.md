# librechat-evals

A code-based, evidence-driven agent + inference evaluation harness for
LibreChat. It uses the same foundation as the companion `camelid-evals`
project — a dependency-free mock server that proves the harness actually
discriminates good behavior from bad, a client that is the only module
allowed to touch the network, deterministic checks wherever a check can be
code, an LLM-judge tier only where semantic judgment is genuinely required
— but restructured and expanded beyond it in three concrete ways:

1. **`evals/` is split into domains** (`inference/`, `agents/`,
   `security/`), each with its own `cases.json`, instead of one flat file —
   camelid-evals keeps one `cases.json` per domain too; the first cut of
   this project didn't, and this fixes that.
2. **Inference gets real weight, not leftovers.** 23 of the 42 shipped
   cases are inference (vs. 11 agent, 8 security), and two mechanisms exist
   here that camelid-evals never needed: numerical accuracy checked by
   extracting and comparing numbers in code (never an LLM judge for
   arithmetic), and long-context needle-in-haystack retrieval with
   distractors. See "Why inference gets more weight here" below.
3. **A golden-reference regression system for inference answers**
   (`scripts/capture-golden.ts`, `scripts/lib/golden-store.ts`) — the same
   "capture once, eyeball it, then detect drift forever" discipline
   camelid-evals uses for its own golden references, generalized from "a
   local engine's byte-identical output" to "did a chat model's answer to a
   fixed question drift from a previously captured, human-reviewed
   reference." A case referencing an uncaptured golden reports `BLOCKED`,
   never a fabricated `PASS` — same guardrail, new domain.

`LIBRECHAT_EVAL_PLAN.md` is the strategy this code implements — read it
first if you haven't. This README is about running the code.

## Why inference gets more weight here

The original brief asked for agent evaluation "in the camelid-evals way,"
and the first version of this project mirrored that literally — roughly
equal agent and inference coverage, agent-shaped categories first. On
reflection (and per explicit follow-up direction) that's backwards for
LibreChat specifically: Phase 0 of the plan doc identifies a real,
unresolved question about whether LibreChat's API even exposes agent
tool-call traces at grade A/B — meaning agent-trace evaluation may turn out
to be the smaller of the two viable tracks once run against a real
instance (see `LIBRECHAT_EVAL_PLAN.md`'s "Track selection" section). A
harness that only builds out agent-eval machinery would be betting
everything on a track that might not even be gradable. Inference evaluation
(factual correctness, hallucination, abstention, instruction following,
constraint satisfaction, consistency, numerical accuracy, long-context
retrieval) works against *any* LibreChat endpoint, agent-backed or not, and
needs no tool-trace evidence at all — so it's the safer, more universally
applicable foundation, and now has the case count and the mechanisms to
reflect that.

## Why this honestly is still a mock-backed project right now

Nothing in this project talks to a real LibreChat deployment yet. Every
case currently runs against `mock-server/server.ts`, a stand-in that
reproduces LibreChat's **documented** API contract (endpoints, request
shape, SSE event types — see "Grounding" below) but whose actual
*tool-call trace behavior* is deliberately unresolved, because that's the
open empirical question `LIBRECHAT_EVAL_PLAN.md`'s Phase 0 identifies.

The harness doesn't guess. `scripts/lib/probe.ts`'s `classifyEvidenceGrade()`
inspects whatever a response actually contains and reports A/B/C/D — and
`grader.ts` respects `evidenceGradeRequired` on a case by returning
`BLOCKED`, not a fabricated pass, when the evidence isn't there. Case
`AGT-011` in `evals/agents/cases.json` demonstrates this directly: routed
through the native SSE flow, whose documented event types don't include a
tool-call schema, it comes back `BLOCKED` every single run.

**Before trusting this against your own deployment:** point
`LIBRECHAT_BASE_URL` (and `LIBRECHAT_TOKEN`) at it, drop the
`x-mock-directives` header usage (real cases won't need
`mockToolTraceMode`/`mockToolFailure`/etc. — those only mean anything to
the mock), and re-run. The evidence grades and inference results you get
back will very likely differ from the mock's, because the mock's job is to
let this harness be verified, not to predict your instance's real
behavior.

## Grounding

Every endpoint this client calls is real and documented, not invented —
fetched and cited on 2026-09-25:

- `POST /api/agents/v1/chat/completions` (OpenAI-compatible surface),
  `POST /api/agents/chat`, `GET /api/agents/chat/stream/:streamId` —
  [Agents API reference](https://danny-avila-librechat-89.mintlify.app/api/agents)
- Documented native SSE event types are `content` / `done` / `sync` /
  `error` — **no documented `tool_calls` event type** — same reference.
- Agents feature list (code interpreter, file search, MCP, web search,
  memory, handoffs, subagents, actions, skills) —
  [Agents | LibreChat](https://www.librechat.ai/docs/features/agents)
- Compatibility matrix (which endpoints support tools/MCP/web
  search/memory) — [Compatibility | LibreChat](https://www.librechat.ai/docs/compatibility)
- OpenAPI spec effort for the public Agents API (Zod-schema-generated,
  CI-validated against drift) — [PR #15928](https://github.com/danny-avila/LibreChat/pull/15928)

What's **not** grounded, and is clearly labeled as such in the code: the
`tool_trace` field on `ChatCompletionResponse` (see `scripts/lib/types.ts`)
is a mock-only convenience field for exercising the evidence-grade
classifier. No citation claims a real LibreChat response contains it.

## Project layout

```
LIBRECHAT_EVAL_PLAN.md          the strategy (Phase 0-12) this code implements
SKILL.md                        guardrails for turning a run into a report
scripts/
  run-harness.ts                CLI entrypoint (all categories, or --category filter)
  capture-golden.ts             pins a reference answer for a goldenId (never overwrites silently)
  lib/
    types.ts                    shared types: case schema, grade schema, evidence grade
    load-cases.ts                merges every evals/<domain>/cases.json
    librechat-client.ts         the ONLY module that talks to the network
    probe.ts                    deterministic AGENT-trace checks + the evidence-grade classifier
    inference-probe.ts          deterministic INFERENCE checks: constraints, numerical accuracy,
                                 needle retrieval
    golden-store.ts             read/write pinned reference answers
    anthropic-client.ts         LLM-judge tier, 2-of-3 voting (reused from camelid-evals)
    grader.ts                   dispatches each case to the right check(s), incl. golden path
mock-server/server.ts           dependency-free stand-in for a LibreChat instance
evals/
  inference/cases.json          23 cases: factual correctness, hallucination, abstention,
                                 instruction following, constraint satisfaction, consistency,
                                 numerical accuracy, long-context retrieval, golden regression
  agents/cases.json             11 cases: tool selection/arguments/grounding/failure-recovery/
                                 termination, incl. the native-SSE evidence-gap demonstration
  security/cases.json           8 cases: direct + indirect prompt injection, data leakage,
                                 privilege escalation
  golden/                       captured reference answers (one demo golden ships; a second
                                 case references an uncaptured golden on purpose, see below)
tests/
  probe.test.ts                 unit tests for agent-trace checks — zero network
  inference-probe.test.ts       unit tests for inference checks — zero network
runs/                           timestamped JSON reports from each harness run
.github/workflows/evals.yml     CI: unit tests + deterministic tiers always;
                                 semantic tier when ANTHROPIC_API_KEY secret exists
```

## Running it

```bash
npm install
npm run mock-server &

npm run evals:deterministic     # free: everything except hallucination/abstention/consistency
npm run evals:inference         # just the inference domain (mix of deterministic + judge cases)
npm run evals:agents            # just the agent domain
npm run evals:security          # just the security domain
export ANTHROPIC_API_KEY=sk-...
npm run evals:semantic          # costs API calls: hallucination/abstention/consistency
npm run evals                   # everything

npm run capture-golden -- <goldenId> <caseId>   # pin a reference answer, see below
npm test                        # unit tests — no network needed
```

Every run writes a timestamped `RunSummary` to `runs/`. The harness exits
non-zero on any `FAIL`/`ERROR` (never on `BLOCKED`/`UNVERIFIED`), so
`evals:deterministic` is safe as a required CI check today.

## Proving the tiers actually discriminate

Verified end-to-end against the unmodified mock: **21 PASS / 14 FAIL / 2
BLOCKED / 0 ERROR** on `npm run evals:deterministic` (37 cases; the other 5
need the semantic tier). Every one of the 14 `FAIL`s is a case deliberately
built to fail — a negative control paired with almost every positive case
— and both `BLOCKED`s are real evidence gaps, not misconfiguration:
`AGT-011` (no tool-trace schema on the native SSE route) and, before
capture, `INF-023` (an intentionally uncaptured golden).

The golden-regression mechanism is verified live too: `INF-023` starts
`BLOCKED` in the shipped repo (no file in `evals/golden/` for
`lc-mcp-support-summary`); running
`npm run capture-golden -- lc-mcp-support-summary INF-023` captures it, and
the case flips to `PASS` on the next run — proving both halves of the
guardrail (never fabricate a missing golden; correctly detect a match once
one exists).

If you change a check in `probe.ts`, `inference-probe.ts`, or `grader.ts`,
re-run this and confirm the same cases still fail for the same reasons —
that's what "the tiers are actually independent and actually checking
something" looks like, the same verification discipline `camelid-evals`
used for its own mock toggles.

## Task failure vs. agent failure

`tool_failure_recovery` cases (`AGT-007`, `AGT-008`) populate `taskAgent`
on their `GradeResult`: the tool is broken either way, so `task` is always
`FAIL` — but `agent` is `PASS` for `AGT-007` (honest report) and `FAIL` for
`AGT-008` (fabricated confidence despite the failure). This is the central
distinction from `LIBRECHAT_EVAL_PLAN.md`, made into an actual field on
every graded result rather than a narrative device in a report.

## Known limitations

- **The mock's tool-call and answer semantics are a simulation, not a
  measurement.** Once you point this at a real instance and get real
  evidence grades and real model answers back, the whole picture (which
  categories are gradable, which inference cases pass) may look different.
  That's expected — it's exactly what Phase 0 is for.
- **`long_context` cases are proof-of-mechanism scale (a few hundred
  words), not real long-context scale.** A meaningful long-context eval
  needs inputs sized to your actual deployment's context window and a
  model/provider configuration that supports it — see Phase 2 §8 of the
  plan.
- **Budget tracking is per-run, not cumulative across runs yet.** Each
  `runs/*.json` records its own `anthropicApiCalls`/token counts (Phase 9);
  summing across runs for a cost-over-time view is a small script not yet
  written.
- **Evaluator validation (manual review of judge verdicts) is a documented
  process in `SKILL.md`, not automated.** Nothing here auto-samples FAILs
  for human review yet.
- **Consistency checking only compares two paraphrases you supply**
  (`pairedInput`) — it isn't a metamorphic-mutation generator yet (that's
  Phase 8 in the plan, deliberately not built until the base cases justify
  scaling).
- **The golden mechanism does exact-match comparison** (after trimming
  whitespace). A real model's answer to the same question will vary in
  wording between calls even when it hasn't "drifted" in any meaningful
  sense — the companion project's own known-limitations section flags the
  identical tradeoff for its prose-idempotence checking. A fuzzier
  (judge-assessed) drift comparison is the natural next step if this
  produces too many false-positive `FAIL`s against a real instance.

## What this deliberately does not do

No case, check, or report produced by this project renders a deploy/ship
verdict on a LibreChat instance (see `SKILL.md` guardrail 6). It reports
what was observed, at what evidence grade, with what confirmed cost — the
decision stays with whoever's reading the report.
