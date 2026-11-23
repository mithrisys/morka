# Review an app workflow

Add `app/morka.preview.json` when creating the first usable screen. Existing projects can add it during any edit. Keep behavior tests in the app, connect them to `morka:check` and use a temporary data directory. Cover durable writes and external service failure in those tests. The Electron review exercises the prepared frontend in an isolated browser session with synthetic responses.

A notebook with an extraction button might use this scenario.

```json
{
  "route": "/",
  "entry": "index.html",
  "watch": ["main.js", "server.mjs"],
  "responses": { "GET /api/notes": [] },
  "actions": { "extract": { "items": ["Email the estimate"] } },
  "steps": [
    { "kind": "fill", "selector": "#note", "value": "I will email the estimate." },
    { "kind": "click", "selector": "#extract" },
    { "kind": "expect", "selector": "#suggestions", "text": "Email the estimate" }
  ]
}
```

Use `publicRoot` for a built asset directory such as `dist`. The route defaults to `/` and serves the HTML entry at that URL. Other assets resolve below the same public root. For server-rendered pages, export a representative HTML entry with synthetic data during the app build. Map backend requests by method, path and query to deterministic JSON. An action fixture must match a registered action's output schema. Include synthetic content only.

Use `fill` for text inputs and textareas, `click` for controls and `key` for Enter, Space, Tab, Escape or an arrow key on the selected element. An `expect` step waits for a visible selector and optional text. Supply up to 40 steps with at least one expectation. Morka reports the failing step and viewport.

Morka runs the first scenario before publishing the edit. A required check can trigger one repair in the same draft. Later changes to the scenario or an exact file path in `watch` schedule a background review of the applied release. A scenario change includes visual inspection. A watched file change runs its behavioral steps. Direct stylesheet edits bypass this work. Use `/review` for fresh app checks and a visual review on demand.

Morka uses a fresh browser session at each of 1280×800 and 640×800. The session serves prepared UI assets and synthetic API and AI responses. An image-capable editing provider receives temporary initial and final screenshots to inspect. Text-only providers get the behavioral result and the visual inspection status. Morka removes local screenshots after review. A background failure can trigger one isolated repair that must pass the original scenario before activation. A new edit cancels the older review.

## Measure live edits

After building Morka, run `electron test/benchmark-live.cjs` using the project's Electron binary. The benchmark changes CSS, markup and JavaScript through chat using a deterministic editing provider. It measures from completion of the draft edit until the live preview accepts the result. Each category has one warmup and 30 unique measured edits. Run the same harness on the base checkout and the candidate, sequentially on the same machine. Save the base JSON output to a file and set `MORKA_BENCHMARK_BASELINE` to its path on the candidate run. The allowed increase in each p95 is the greater of 50 ms and five percent.
