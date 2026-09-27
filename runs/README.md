# runs/

Timestamped JSON reports from `npm run evals` (or `evals:deterministic` /
`evals:semantic`) land here as `run-<ISO timestamp>.json`. Each file is a
`RunSummary` (see `scripts/lib/types.ts`): every case's verdict, its
observed evidence grade, its reasons, its trace, plus the run's total
Anthropic API usage — everything Phase 9 of `LIBRECHAT_EVAL_PLAN.md` asks a
run to record.

Raw run files are gitignored by default (`.gitignore`) so the repo doesn't
accumulate noise; commit specific runs deliberately when they're evidence
for a report or a conference claim, per the "reproducibility requirements"
section of the plan.
