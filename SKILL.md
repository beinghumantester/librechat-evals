# LibreChat Agent/Inference Drift & Capability Reporter

A guardrailed skill for turning a `runs/*.json` report from this harness
into a plain-English findings report — without ever saying more than the
run actually measured. Same discipline as the companion `camelid-evals`
project's skill, applied to LibreChat.

## Guardrails

1. **Never upgrade `DOCUMENTED` to `OBSERVED` or `OBSERVED` to `EVALUATED`
   on your own authority.** Those transitions only happen because a run's
   `GradeResult` actually has a verdict for that case. If a capability has
   no case in the run, say "not evaluated in this run," not "works."

2. **Never report a case's evidence grade as higher than
   `observedEvidenceGrade` in the run JSON.** If a case came back `BLOCKED`
   because the observed grade didn't meet `evidenceGradeRequired`, report
   that gap explicitly — it's a finding about LibreChat's observability,
   not a skipped test to gloss over.

3. **Always report task and agent verdicts separately when
   `taskAgent` is present on a result.** "Task failed, agent behaved
   correctly" and "task failed because the agent behaved badly" are
   different findings and must never be collapsed into one line.

4. **Never call a single `FAIL` a "regression" or a "pattern."** Cite the
   case id, the actual `reasons[]` text, and the run timestamp. A pattern
   claim needs multiple runs or multiple cases, cited as such.

5. **Never treat the evaluator's own verdict as ground truth without the
   evaluator-validation step.** If asked to summarize failures, say how
   many were manually reviewed and how many of those were confirmed vs.
   false positives — per `LIBRECHAT_EVAL_PLAN.md`'s "Evaluator validation"
   section. If that review hasn't happened yet, say so instead of
   presenting the raw `FAIL` count as confirmed defects.

6. **Never render a deploy/ship/promote verdict.** This skill reports
   what was observed; it does not decide whether a LibreChat deployment is
   ready for anything. State findings and next actions, not approvals.

7. **Never fabricate a trace field.** If `trace.toolCalls` is empty or a
   field is `undefined`, say the evidence wasn't there — do not infer what
   "probably" happened.

8. **Always cite cost alongside any failure-rate claim.** Per Phase 9 of
   the plan: `confirmed unique failures / API calls`, with the run's
   `anthropicApiCalls` / token counts shown next to it, never the rate
   alone.

9. **Always state next actions, never certainty about unmeasured
   capabilities.** "Run more cases against category X" or "confirm this
   against a real instance, not just the mock" are valid closing lines;
   "LibreChat is reliable" is not, from one run.

10. **Protect any real credentials, tokens, or instance-specific URLs**
    that might appear in a `LIBRECHAT_BASE_URL` or trace payload — redact
    them in any report meant to leave a private environment.

## Report shape

When asked to summarize a run, produce, in this order:

1. **Environment** — `baseUrl`, whether it was the mock server or a real
   instance, run timestamps.
2. **Headline numbers** — PASS/FAIL/BLOCKED/UNVERIFIED/ERROR counts, cost.
3. **Findings** — one per FAIL, with case id, category, task/agent split
   if present, the actual `reasons[]`, and the observed evidence grade.
4. **What was BLOCKED and why** — this is often the most important
   section for LibreChat specifically, since evidence-grade gaps are a
   real, reportable property of the system, not administrative noise.
5. **Limitations** — anything not covered in this run, mock-vs-real
   caveats, sample size.

Never skip straight to "conclusions" without these sections present.
