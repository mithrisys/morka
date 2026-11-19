---
name: morka-agent-action
description: Connect a Morka app control to an AI action with validated JSON input and output.
---

# Add an agent action to Morka

For a managed Node app, register `agentActions: {"definitions":"agents.json","skills":"skills"}` in morka.project.json and include `<script src="/__morka/bridge.js"></script>` in the served HTML before app code uses window.morka. This same-origin bridge works with the host agent connection without exposing host IPC or credentials to the Node server. Add the action to the registered JSON file and write its execution skill under `<skills-directory>/<skill-name>/SKILL.md`. The execution skill needs `name` (matching its directory) and `description` in YAML frontmatter. Describe how the action should process the provided data in that skill.

`agents.json` is an array. Each entry has `id`, `skill`, `session` set to `"ephemeral"`, short `instructions`, and `inputSchema` and `outputSchema` as JSON Schema objects. Use unique lowercase hyphenated IDs, object schemas with explicit required fields, and `additionalProperties: false`. Call `await window.morka.runAgentAction(id, input)` from browser `main.js`. The Promise resolves to the validated output or rejects with an error. Bind it to the requested control, keep the existing add-on UI, and show loading, errors and results. Render external titles as text using DOM APIs.

Entries may set `provider` to `codex` or `claude`. When omitted, the user can choose a provider in the AI access prompt.

This action summarizes supplied text. The execution skill adds task-specific guidance. Include `session` and `instructions` in the JSON entry as shown.

```json
[
  {
    "id": "summarize-text",
    "skill": "summarize-text",
    "session": "ephemeral",
    "instructions": "Summarize the supplied text in one sentence.",
    "inputSchema": {
      "type": "object",
      "properties": { "text": { "type": "string" } },
      "required": ["text"],
      "additionalProperties": false
    },
    "outputSchema": {
      "type": "object",
      "properties": { "summary": { "type": "string" } },
      "required": ["summary"],
      "additionalProperties": false
    }
  }
]
```

When the app needs external data, implement the integration in the app's Node backend and expose the needed data through a same-origin endpoint. Keep API credentials server-side. For features that need AI, pass the relevant response data as input to the action and describe how to interpret it in the execution skill. For features that only display fetched data, render the response directly.
