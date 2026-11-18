# DecisionModels-Demo

Examples and a local UI for comparing decision models and invocation modes.

## Decision Lab

The app in [`demo/`](demo/) is a compact dark workspace for racing decision-model commands and generative LLMs against shared JSON requests. It includes live finish positions, probabilities, model/effort metadata, end-to-end/reported timings, warm-up, and charts.

```powershell
cd demo
npm ci
npm run dev
```

Open **http://127.0.0.1:4310**. Configure commands in [`demo/config.json`](demo/config.json); add inputs to [`demo/requests/`](demo/requests/).

The included LLM entry uses Copilot authentication, with its system prompt, model, and reasoning effort configured in the same file. **Parallel race** is the default execution mode.

See [`demo/README.md`](demo/README.md) for prerequisites, configuration examples, timing semantics, and tests.

## Original examples

- [`examples/demo_00/`](examples/demo_00/): single- and multi-question JSON requests.
- [`examples/demo_code/ghcp_decision_00.cs`](examples/demo_code/ghcp_decision_00.cs): Copilot SDK Decisions API example.
