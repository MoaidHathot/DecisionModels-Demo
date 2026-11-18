# Research and verification

## Goal and plan

Build a small responsive demo centered on comparing **invocation presets**. Each preset has a name and either a command with an input-file placeholder or explicit LLM settings. One underlying model can have multiple independent presets.

1. Inspect the repository, PowerShell profile, and actual command contracts. Implement/test config loading, frozen inputs, execution, parsing, and warm-up.
2. Build the responsive UI: selection, hidden JSON editor, live table, raw inspection, and charts. Review timing/probability semantics against the real responses.
3. Verify unit/process/API behavior, production build, browser flows, accessibility, and actual tools. Fix findings and document reproducible setup.

## Evidence gathered before implementation — 2026-11-18

Repository context: the existing single/multi-question files in `examples/demo_00/` use `state` and named `predicate`, `choice`, and `score` questions. There was no existing app/framework to extend.

Inspected the installed CLI help and executed:

```powershell
dnx copilot.decision.cli -- --help
dnx copilot.decision.cli -- decide --input examples/demo_00/01_multiple.json

# In a new pwsh process with profiles enabled:
LocalLaya --help
LocalLaya --sidecar --file examples/demo_00/01_multiple.json --json
LocalLaya --local --file examples/demo_00/01_multiple.json --json
```

Also inspected the local LocalLaya sources/docs: `ask.mjs`, `README.md`, and `docs/REQUESTS.md`. Relevant observations:

- The profile defines `LocalLaya` as a function forwarding to `ask.mjs`, sets `LAYA_MODEL=multilingual` and `LAYA_SIDECAR=1`. Explicit `--local` overrides the sidecar environment default.
- Profile startup can emit PSReadLine errors when the shell is noninteractive. The commands still succeeded. The app preserves stderr and uses command exit status plus valid stdout JSON, so diagnostic noise does not fabricate a failed/successful decision.
- Copilot returned `model: microsoft-decision-1.1`, `elapsedMilliseconds`, and an `answers` object. Predicate probability is `probability`; choices expose a named probability map; scores expose a level array and probability array.
- LocalLaya returned `routing.model: multilingual`, `routing.ms`, `routing.exec.mode`, `backend: remote|local`, and `answers`. Predicates use `noul`; score probabilities use indexed objects with a `legend`.
- LocalLaya's first cold sidecar invocation took about 11.1 seconds in the manual probe; `routing.ms` was about 552 ms. The local one-shot took about 8.3 seconds; `routing.ms` was about 713 ms. These are individual observations, not benchmark estimates.
- `--start` can load a sidecar without performing the selected request. The provided warm-up repeats the configured decision invocation, which also exercises the actual question shape.
- LocalLaya sidecars may idle out and a shared port can change model families. Historical warm-up status is not a promise of current readiness.

`tests/fixtures/copilot-response.json` and `locallaya-response.json` preserve the observed response fields needed for normalization tests. The Copilot credential-source identifier and unrelated LocalLaya environment/version detail were omitted; decision values and timings were preserved.

## Decisions and review checkpoints

### Runner checkpoint

- Fresh PowerShell processes preserve profile-defined commands and isolate invocation settings.
- The input placeholder is an unquoted token replaced with a PowerShell single-quoted, apostrophe-escaped path. JSON content remains file data.
- Every batch snapshots its config and request payloads before dispatch. One row is one invocation, regardless of question count.
- The initial version defaulted to sequential dispatch. The revised UI defaults to parallel races (see below). Warm-ups are separate run types; one-shot local runs remain one-shot.
- Exit code, missing/invalid response, output bound, timeout, and cancellation are explicit outcomes. One failed preset does not abort unrelated presets.
- Initial 22 checks passed, including actual `pwsh` transport and terminating a spawned native grandchild on cancellation. API/SSE and statistics checks brought the suite to 25 checks.
- Review caught two edge cases and added regression coverage: noisy/unmatched braces must not trigger quadratic response scanning; changed command settings must invalidate a historical warm-up badge.

### UI checkpoint

- Selection and command presets stay distinct from returned model/backend metadata.
- Choice probabilities come from the chosen option, not `confidence`; negative predicates still say P(yes); score labels follow the most probable level, with the expected score retained.
- Charts aggregate invocation samples exactly once, omit errors/warm-ups, and preserve same-model presets as separate series.
- SSE sends a complete snapshot on connection/reconnection; page refresh can restore an active pasted-JSON comparison.
- Inputs, diagnostics, raw stdout, and exit codes remain inspectable. Charts and the initial screen contain no manufactured result data.
- The production build and strict TypeScript check passed before browser validation.

### Browser findings and fixes

- The first development launch exposed a `node --watch` restart loop: Vite's generated config bundle was imported, then deleted, triggering another restart. Development now uses Vite's **native config loader**, supported by the required Node version. A real development browser session verified HMR, and a separate lifecycle check verified graceful shutdown with its HMR WebSocket still open.
- A visually hidden table heading was escaping its scroll container and expanding the mobile document to 1,008 px. Giving the scroll container a positioning context keeps the document at exactly **390 px / 320 px**, with only the table scrolling horizontally.
- Native dialogs now explicitly close and restore focus to their trigger. Keyboard checks verify focus after request/result previews and the configuration dialog.
- Contrast checks identified several too-light labels and a near-threshold green chart highlight; these were corrected. The table, charts, and configuration dialog pass the automated WCAG checks.
- Answer/probability stacks use matching row heights, so a score annotation cannot shift a later question's probability out of alignment.
- Review also found a late-cancellation edge case: a stop response can arrive after the server has already finished, especially during a stream interruption. All authoritative snapshots now update both the results and operation flags, including clearing a stale reconnecting/stopping state.

## Real runner smoke evidence

The initial `npm run test:live` checked the three original command entries. The warm-up and all three comparison invocations passed; each returned the three requested decisions and a model name.

| Invocation | Returned model | End-to-end | Tool-reported |
|---|---|---:|---:|
| Sidecar warm-up | Lifecycle check | 11,251.4 ms | Excluded from comparison |
| GitHub Copilot | microsoft-decision-1.1 | 5,064.1 ms | 2,555.6 ms |
| LocalLaya sidecar | multilingual | 834.0 ms | 128.8 ms |
| LocalLaya local | multilingual | 7,254.8 ms | 463.8 ms |

These are **one smoke run's measurements**, with PowerShell/profile overhead included in end-to-end time. Copilot and LocalLaya's reported clocks have different scopes. They do not establish comparative model accuracy or stable performance rankings.

The latest normalized/raw artifact is generated locally at `.artifacts/live-smoke.json` (ignored by Git). Each execution replaces it with current evidence for that machine and configuration; the table above records the initial run.

A second verification used the **actual browser UI → HTTP API → PowerShell → real tools** path, including the warm-up button. All three invocations completed with three answers each, and no browser script errors:

| Invocation | End-to-end | Tool-reported |
|---|---:|---:|
| GitHub Copilot | 5,488.5 ms | 2,927.9 ms |
| LocalLaya sidecar | 818.6 ms | 120.0 ms |
| LocalLaya local | 7,681.6 ms | 466.5 ms |

That run's raw export and desktop/mobile/chart screenshots are under `.artifacts/live-ui*`. The model names were `microsoft-decision-1.1` and `multilingual`, matching the directly observed contracts.

## Browser verification

Browser checks exercise the production UI against real PowerShell processes running deterministic test CLIs. No API responses are mocked. Coverage includes:

- File selection, JSON preview, warm-up isolation, live pending/completed rows.
- Probability labels, raw command/stdout/stderr, distributions, and exported JSON.
- Repetitions, parallel dispatch, pasted JSON validation, Unicode and literal shell-looking content.
- Page refresh while a pasted-JSON run is active.
- Nonzero exit codes and cancellation of active/queued invocations.
- Interrupted streams and a stop request acknowledged after completion, followed by another cancellable run.
- Charts, same-model preset grouping, responsive 390 px / 320 px layouts.
- Keyboard/dialog behavior and automated WCAG accessibility checks with axe.

Screenshots and failure traces are generated under `test-results/` (ignored by Git).

Installation was also checked with a clean **`npm ci --no-fund --no-audit`**, using the portable lockfile and the machine's configured registry. It passed without a per-command remote-package override.

## Initial implementation verification — 2026-11-18

| Check | Result |
|---|---|
| Clean dependency installation | Passed |
| Strict TypeScript + Vite production build | Passed |
| Unit/process/API/statistics suite (`npm test`) | **25 passed**, no skips |
| Production browser suite (`npm run test:e2e`) | **6 passed**, no skips |
| axe checks: results table, charts, configuration dialog | Zero WCAG 2 A/AA and WCAG 2.1 A/AA violations in the checked states |
| Mobile layout | Document fits 390 px and 320 px; the table scrolls within its container |
| Real command runner smoke | Copilot, LocalLaya sidecar, LocalLaya local, and warm-up passed |
| Real browser-to-command comparison | All three presets passed; three decisions each; no browser script errors |
| Development mode | Native-config startup, browser rendering, HMR connection, and graceful shutdown with an open browser passed |

The browser suite uses the real production server and real PowerShell child processes with deterministic fixture commands. The separate real-tool runs above verify integration with the installed Copilot and LocalLaya tools.

## Dark workspace, parallel races, and LLM comparison

### Research and implementation

The follow-up request called for a dark, compact UI with the introductory hero removed, visible parallel finish order, and a configurable LLM baseline.

- Inspected **Copilot CLI 1.0.112** help and the **`@github/copilot-sdk` 1.0.34** API. The CLI exposes model/effort switches; the SDK additionally supports a true replacement system message and request-specific structured output.
- Queried `client.listModels()` using the existing login. **`gpt-6-luna`** advertised `none`, `low`, `medium`, `high`, `xhigh`, and `max`; a real request confirmed `low` through usage metadata and `session.rpc.model.getCurrent()`.
- Kept a captured LLM reply in `tests/fixtures/llm-response.json`. Its score was 1.4 while its distribution implied 1.0. Normalization preserves that response and reports the discrepancy instead of silently rewriting it. LLM probability labels explicitly say **Est.**
- The configured system prompt is the SDK's replacement system message; the frozen input JSON is the user message. The output schema preserves question IDs, allowed choices, and level counts. No tools, repository instructions, skills, or cross-session memory enter the classification context.
- Model and effort are validated against the runtime catalog. The returned model and effort are taken from runtime metadata, not from claims in the generated text.
- Each LLM invocation runs in an isolated child process using the existing timeout/cancellation path. Settings use UUID filenames so even IDs differing only by case remain independent on Windows. The settings used by the run are included in details and JSON exports.
- **Parallel race** dispatches every selected entry together for a request/repetition, streams successful finish positions, then waits for that entire group before the next request. It rejects a concurrency cap below the selected entry count rather than staggering the race.
- Removed the hero, tagline/footer, large summary cards, idle status hints, and repeated request descriptions. The dark workspace emphasizes selectors, a compact control bar, and the table; native and LLM model/effort metadata remain visible.

### Four-entry runner verification

The first revised `test:live` warmed LocalLaya, then raced the original three command presets and the new LLM entry:

| Finish | Entry | Returned model | End-to-end | Reported |
|---|---|---|---:|---:|
| 1 | LocalLaya sidecar | multilingual | 798.4 ms | 22.2 ms |
| 2 | Copilot Decisions | microsoft-decision-1.1 | 5,110.7 ms | 2,484.9 ms |
| 3 | LocalLaya local | multilingual | 8,581.2 ms | 502.5 ms |
| 4 | Copilot LLM, low reasoning | gpt-6-luna | 12,896.6 ms | 4,160.5 ms |

All four returned the three requested answers. These are individual invocation measurements, with different reported timing scopes, rather than stable performance estimates.

### Live browser verification with the current configuration

A subsequent **production browser → API → real processes** race exercised the updated five-entry configuration. All five succeeded, the LLM's actual effort was `low`, and the frozen model/prompt/effort settings were visible in the result dialog and export.

| Finish | Entry | End-to-end | Reported |
|---|---|---:|---:|
| 1 | GitHub Copilot Decisions | 4,042.5 ms | 2,607.8 ms |
| 2 | LocalLaya local / multilingual | 7,691.3 ms | 390.9 ms |
| 3 | Copilot LLM / GPT-6 Luna | 13,325.6 ms | 7,731.0 ms |
| 4 | LocalLaya Vega sidecar | 15,810.9 ms | 3,425.3 ms |
| 5 | LocalLaya multilingual sidecar | 26,524.1 ms | 499.0 ms |

The two sidecar entries shared the default port, so this run includes model switching/reloading and queueing. It also exposed a Vega warm-up that omitted `--model vega`; both sidecar warm-up commands were subsequently aligned with their corresponding model selections. Separate ports are available for experiments that should keep both model families loaded independently.

Evidence: `.artifacts/dark-live-ui.json`, `.artifacts/dark-live-*.png`, `.artifacts/dark-llm-settings.png`, and `.artifacts/dark-a11y.json`. The real initial configuration, completed table, LLM settings dialog, and charts had **zero axe WCAG A/AA violations** in the checked states and no browser script errors. The mobile document stayed within its viewport while the table scrolled internally.

### Updated verification

- **35 unit/process/API/LLM/race/statistics tests passed**, with no skips. This includes race barriers, live rank assignment, cancelling all active contenders, unsupported model-output shapes, immutable LLM settings, and case-distinct preset IDs on Windows.
- **All 6 production browser tests passed**, with no skips. They cover dark appearance, compactness, finish sorting, estimated LLM probabilities, exports, mobile layout, accessibility, and interrupted-stream recovery. The strict TypeScript check and production build also passed.
- A clean install was performed in a temporary directory, followed by importing the SDK's stdio client exports. Installation/import passed with the machine's npm script policy; the demo uses stdio rather than the optional in-process FFI transport.
