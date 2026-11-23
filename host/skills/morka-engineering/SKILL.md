---
name: morka-engineering
description: Implement and verify durable app behavior.
---

Respect the user's explicit stack, existing interfaces and storage. Use built-in Node APIs for simple work. Introduce a package when it solves a concrete need. Separate persistent storage and external calls from pure transformations, validate boundary inputs and preserve existing data on failure. Test behavior with node:test, temporary directories and synthetic inputs. Wire fast deterministic tests to morka:check. Example: use a fixed agent response, correct a proposed commitment, save it, reopen the store and verify the corrected value. Simulate provider failure and verify the original note remains. Add tests for the changed behavior; do not rewrite unrelated tests on a cosmetic edit.

For a first usable UI, create morka.preview.json in the draft root. Example:
```json
{"route":"/","steps":[{"kind":"fill","selector":"#note","value":"Send the estimate"},{"kind":"click","selector":"#extract"},{"kind":"expect","selector":"#result","text":"Send the estimate"}],"actions":{"extract":{"items":["Send the estimate"]}},"watch":["main.js","server.mjs"]}
```
Steps accept fill, click, key (Enter, Space, Tab, Escape and arrows) and expect. Use stable CSS selectors. An expect step can check visibility alone. Specify publicRoot for built assets, entry for HTML, and responses keyed by method and path (e.g. "GET /api/notes") for synthetic JSON API fixtures. Declare relevant app files in watch for background behavioral reviews. Keep credentials and real user data out of every fixture. Browser review uses prepared frontend assets; cover server persistence in node:test.
