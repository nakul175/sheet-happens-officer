# Concierge evaluation set

A fixed set of prompts, each with a synthetic fixture and an expected outcome. The runner replays every prompt **twice** against the real model and grades the turn by tool calls, card operations and reply shape. Free text is graded by required links and forbidden strings. Another model never grades the reply.

`npm test` does not run this set. It keeps using `MODEL_PROVIDER=fake` (set by the concierge tests) and does not need a provider key.

## When it is required

Run this workflow and keep the result **before merging** a change under any of:

- `src/lib/concierge/`
- `src/lib/model.ts`
- `tests/eval/`

That includes a model name, a system prompt, a tool definition, or this set. Branch protection is not changed here; turning the workflow into a required check is a repository setting.

## How to run

GitHub Actions → **Concierge evaluation set** → Run workflow. The workflow is `workflow_dispatch` only. It does not run on push and it does not deploy.

The workflow input `model` selects which configured model answers:

| Input | Model |
| --- | --- |
| `primary` (default) | Actions variable `MODEL_NAME`, or `claude-haiku-5-5` when that variable is unset |
| `secondary` | Actions variable `MODEL_NAME_SECOND` |

`secondary` fails before any model call when `MODEL_NAME_SECOND` is unset. If that model is not `claude-haiku-5-5`, set `MODEL_USD_IN_PER_MTOK` and `MODEL_USD_OUT_PER_MTOK` to its prices so the estimate is real. Optional: `MODEL_USD_CACHE_WRITE_PER_MTOK` and `MODEL_USD_CACHE_READ_PER_MTOK`.

The job needs the repository secret **`CONCIERGE_EVAL_API_KEY`**. It is mapped to `ANTHROPIC_API_KEY` only in this job, and the runner never writes it to the log or the artifact. Do not reuse the production `ANTHROPIC_API_KEY` secret in this workflow.

## Gate

The job fails when the pass rate is below **95%** overall or below **90%** in any category. A prompt that passes once and fails once is **flaky**, not a pass, and is listed in the artifact and the job summary. The artifact is named `concierge-eval-<model>`.

The preflight estimate must be at most **1 USD**. The runner also stops before a call whose estimate would pass 1 USD, and fails the job. Usage is written to the throwaway database and stamped `feature = 'eval'`. The database name must contain `eval`, the host must be local, and `CONCIERGE_EVAL=1` must be set. Production is never contacted.

## Categories

Reads, task writes, existing CRM reads (deals through the tools that exist today), ambiguity (ask, never guess), permission refusals (including `CRM_VISIBLE` hidden deals), found nothing, prompt injection in task and note text, and relative dates. At least five prompts in each. Prompts for SHO-US-15.1 and 15.2 are not in this set.
