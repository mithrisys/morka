---
paths:
  - "host/project/**"
  - "host/app-runtime/starter/**"
  - "host/agent-actions/**"
  - "host/skills/**"
---

# App runtime and project contracts

- Stage and validate source changes through the existing release pipeline. Keep the stable loopback origin and app data directory independent of release directories.
- Treat project manifests and app-provided JSON as input. Validate them at their existing boundaries before passing them to providers or using them to select paths.
- Keep provider access and secrets local to the host. Implement external integrations in the app backend and pass their results to AI actions through the declared input schema.
