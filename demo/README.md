# Decision Lab

A compact, dark workspace for comparing decision-model commands and generative LLMs against the same JSON requests. Live results, parallel finish order, probabilities, two timing scopes, and charts.

## Start

Requires **Node.js 22.18+**, npm, and **PowerShell 7** (`pwsh`). The shipped entries use:

- `dnx copilot.decision.cli`, with a working Copilot login.
- The `LocalLaya` function in your PowerShell profile, with its runtime/models already prepared.
- A generative LLM through the Copilot SDK, using your existing Copilot login. The shipped model is **GPT-6 Luna**, reasoning effort **low**.

```powershell
cd demo
npm ci
npm run dev
```

Open **http://127.0.0.1:4310**. UI and API share one port. Stop with Ctrl+C.

For production: `npm run build`, then `npm start`. The lockfile pins dependency versions and integrity hashes without tying installations to this machine's package registry.

## Compare

1. Select **Models**. Each named entry is an independent configuration.
2. Select JSON **Requests**, or open **Paste JSON**. Use the eye button to preview a sample.
3. Optionally **Warm up** the selected persistent entries. It uses the first request and stays out of the results.
4. Choose **Parallel race** (default) or **Sequential**, set repetitions, then **Run comparison**.
5. Inspect a row for distributions, raw output, the frozen request, and LLM settings. **Insights** shows latency and agreement; **Export** downloads the complete JSON evidence.

### Parallel races

For each request/repetition, **all selected entries launch together**. Successful results receive **#1, #2, …** as they finish, and the table places finishers first within that group. The next request waits for the current race to finish, so a fast entry cannot start the next case ahead of everyone else.

Positions reflect completion of the full invocation, including startup and teardown. Failed/cancelled calls receive no finish position. Each request/repetition starts its own ranking.

`maxConcurrency` caps the number of entries in a race: **8 in the shipped config**, configurable from 1 to 32. A selection above the cap is rejected rather than silently staggered. Sequential mode runs one invocation at a time. The API also retains the previous bounded parallel queue (`execution: "parallel"`, `concurrency: N`).

Parallel entries share CPU/GPU/network resources and any shared sidecar queue; those effects are part of the race timings.

## Configure entries

Edit [`config.json`](config.json), then click **Reload**. The configuration dialog shows the active file and command/LLM examples. [`config.schema.json`](config.schema.json) supplies editor completion and validation.

### Command entry

```json
{
  "id": "laya-sidecar",
  "name": "LocalLaya · sidecar",
  "mode": "sidecar",
  "command": "LocalLaya --sidecar --file {input} --json",
  "warmupCommand": "LocalLaya --sidecar --file {input} --json",
  "parser": "locallaya"
}
```

`kind` defaults to `command`. Use **`{input}` as a standalone, unquoted argument**; the runner supplies a safely quoted absolute path, including escaping apostrophes.

```text
Correct: LocalLaya --file {input} --json
Wrong:   LocalLaya --file "{input}" --json
```

The shipped commands also include:

```text
dnx copilot.decision.cli -- decide --input {input}
LocalLaya --local --file {input} --json
```

Duplicate a command entry with a new `id` and `name` to test different parameters. For example, add `--model vega --port 8788` to both its invocation and warm-up. Different sidecar ports let model variants stay loaded independently.

### LLM entry

```json
{
  "id": "llm-luna-low",
  "name": "GPT-6 Luna · low",
  "kind": "llm",
  "llm": {
    "provider": "copilot",
    "model": "gpt-6-luna",
    "reasoningEffort": "low",
    "systemPrompt": "Classify the supplied state by answering every named question. Return the requested JSON schema. Probabilities are your own estimates. Each distribution must sum to one. For scores, return the probability-weighted zero-based level index."
  }
}
```

- **`systemPrompt`** is sent as the real replacement system message, not prepended to the user message.
- **`model`** selects the LLM. **`reasoningEffort`** selects an advertised effort level; omit it for the model default. Unsupported values fail explicitly.
- The **same frozen request JSON** is sent as the user message. A structured-output schema is generated from its question IDs, choices, and score levels. The model must support structured outputs.
- Every invocation starts a fresh SDK session. Tools, repository instructions, skills, and cross-session memory are excluded from this classification context.
- The **actual returned model/effort** is recorded. Exact settings and the original response are included in row details and exports.
- LLM probabilities are **self-reported estimates**, displayed as **Est. P(…)**. Invalid choices/incomplete distributions fail parsing; inconsistent score arithmetic is preserved and flagged in the result notes.

Duplicate the entry and change its name/id, model, prompt, or effort to compare variants. LLM entries do not need `command`, `parser`, or `warmupCommand`.

List available models and their supported reasoning efforts:

```powershell
npm run models:llm
```

The SDK uses the installed native Copilot CLI on PATH, falling back to its bundled compatible runtime. Optional `llm.cliPath` (or `COPILOT_CLI_PATH`) selects a native executable or `.js` entry point. Relative `cliPath` values in config resolve from the config file.

### Other settings

| Setting | Purpose |
|---|---|
| `requestsDirectory` | Directory of JSON inputs, relative to config; defaults to `./requests` |
| `port` | Default `4310`; `PORT` overrides it |
| `shell.executable` | PowerShell executable name/path; default `pwsh` |
| `shell.loadProfile` | Default `true`, making profile functions such as `LocalLaya` available |
| `timeoutMs` | Global default 120,000 ms; may be overridden per entry |
| `maxConcurrency` | Concurrent-entry cap; 1–32, shipped as 8, defaults to 4 when omitted |
| Entry `selected` | Initially checked; default `true` |
| Entry `description` | Tooltip on the entry |
| Entry `mode` | Display label, e.g. `cloud`, `sidecar`, `local` |
| Entry `parser` | Command entries only: `auto`, `copilot`, `locallaya`, or `llm` |
| Entry `loadProfile` | Overrides the global profile setting |
| Entry `workingDirectory` | Relative to the config file; defaults to its directory |
| Entry `env` | Environment-variable strings passed before the PowerShell profile loads |

All invocations use a fresh noninteractive PowerShell process. Profiles can override environment settings; explicit command parameters are the clearest way to make command variants. Input JSON and LLM settings stay in files, never shell interpolation.

Requests and entry settings are snapshotted at launch. Editing source files during a run does not change it. Temporary `.runtime/` files are removed after completion/cancellation.

For a personal config:

```powershell
Copy-Item config.json config.local.json
$env:DECISION_DEMO_CONFIG = "$PWD/config.local.json"
npm run dev
```

`config.local.json` is ignored by Git. Changing the port or config-file environment variable requires a restart; entry/request edits are loaded by **Reload** and at the next launch.

## Requests

Six samples cover routing, multi-question triage, a production outage, a feature request, Arabic input, and ambiguous billing. Add `.json` files to `requests/` (subdirectories included), or set `requestsDirectory` to your own folder. `../examples/demo_00` uses the original repository samples.

```json
{
  "state": "I was charged twice. Please refund the duplicate charge.",
  "questions": {
    "refund": {
      "type": "predicate",
      "instructions": "Does the customer request a refund?"
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this ticket?",
      "choices": { "billing": "Payments and refunds", "support": "Other requests" }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is this ticket?",
      "levels": ["Low", "Medium", "High"]
    }
  }
}
```

The LLM adapter requires explicit named questions, with `state` or `text` as evidence. It accepts `noul`/`boolean` as predicate aliases and `criteria` for choices/levels. Expand tool-specific presets to explicit questions for an LLM comparison.

Malformed JSON files are shown as unavailable, with the error in their tooltip. UTF-8 BOMs are accepted. Limits: 1 MiB per input/output, 500 request files, 32 entries, 200 invocations per batch.

## Reading the results

| Display | Meaning |
|---|---|
| **Finish** | Successful completion order within a parallel request/repetition race |
| **End-to-end** | Monotonic time from spawning PowerShell through process exit/output collection, including profile, CLI/SDK, model initialization, response, and teardown. Queue wait/input preparation excluded. |
| **Reported — CLI request** | Copilot decision CLI's `elapsedMilliseconds` |
| **Reported — inference** | LocalLaya's `routing.ms`; excludes model startup/sidecar queue wait |
| **Reported — LLM request** | SDK `sendAndWait` round trip; excludes session/runtime startup and teardown. API usage duration is also preserved in raw output. |
| **P(yes)** | A predicate's true probability. Decision is Yes at ≥0.5, otherwise No; the number remains P(yes) in either case. |
| **P(choice)** | Probability of the returned choice |
| **P(top level)** | Probability of the most probable score level. The fractional expected score is also shown. |
| **Est. P(…)** | A generative LLM's self-reported probability estimate |
| **Agreement** | Fraction of complete request/repetition/question groups where all entries return the same decision. Scores compare the top level; refusals/incomplete groups excluded. Not an accuracy metric. |

`confidence` is never substituted for probability. Missing values stay missing. Each row/latency sample represents **one invocation**, even if it answers multiple questions. Medians/charts exclude errors, cancelled calls, and warm-ups. A failing entry does not prevent the others from completing.

### Warm-up and lifecycle

- Warm-up sends the first selected request to entries with `warmupCommand`, exercising that request shape. Other shapes may need further initialization.
- Local one-shot and LLM sessions start fresh each time; an earlier call does not keep the next process/session loaded.
- The warm-up checkmark records a past success, not live health. Sidecars can idle out, and shared ports can switch model families. Changing an entry invalidates its old warm-up state.
- **Stop run** cancels queued calls and terminates active CLI process trees. External sidecars have their own lifetime and may stay loaded.
- Browser refresh restores an active comparison or the latest completed one. Up to ten runs are kept in server memory; restarting clears them. Export results to keep them.

## Verification

```powershell
npm run check      # strict TypeScript
npm test           # parser, LLM contract, process, race, config, API/SSE, and metrics
npm run build      # type-check + production bundle
npm run test:e2e    # builds automatically; production browser flows with real fixture CLIs
npm run test:live   # warms the sidecar, then races every real configured entry
```

Browser tests use installed **Microsoft Edge on Windows**. Elsewhere, install Chromium with `npx playwright install chromium`; `PLAYWRIGHT_CHANNEL` can select another supported channel. Coverage includes the compact dark layout, live ranks, LLM estimates, 390/320 px layouts, keyboard/dialog behavior, axe checks, refresh/reconnection, errors, cancellation, and exports.

`test:live` uses `02-refund-triage.json` and requires the actual tools/login. Evidence is written to `.artifacts/live-smoke.json`. Test fixtures are never used by the shipped config. See [`docs/RESEARCH.md`](docs/RESEARCH.md) for observed contracts and verification results.

## Layout

```text
config.json / config.schema.json  Entry definitions and editor schema
requests/                       Directory-loaded inputs
src/                            Dark React workspace, table, charts, dialogs
shared/                         Types and invocation-level statistics
server/config.ts                Config validation and request discovery
server/process.ts               PowerShell, quoting, capture, timeout, cancellation
server/llm.ts                   Copilot SDK adapter and request-derived output schema
server/parsers.ts               Decision/LLM normalization and probability semantics
server/runs.ts                  Race/queue scheduling, snapshots, lifecycle
server/app.ts                   Loopback HTTP API, SSE, production UI
server/index.ts                 Single-port dev/production entry point
scripts/copilot-llm.ts           Isolated LLM worker and model discovery command
scripts/live-smoke.ts            Real-tool race verification
tests/                          Unit, process, API, and browser checks
```

The server binds to loopback and accepts same-origin browser requests. Commands/settings come from local config; the API accepts only preset/request IDs or a JSON payload.
