---
paths:
  - "host/electron/**"
  - "host/renderer/**"
  - "host/app-runtime/bridge.ts"
  - "host/project/live-preview.ts"
  - "host/project/page-state.ts"
---

# Electron and live preview

- Keep renderer and preload changes synchronized with the IPC types and handlers. Verify access from both the intended frame and a different origin when changing app requests.
- Use the existing preview transition and lifecycle hooks when changing reload behavior. Verify that successful updates restore route, input, focus, and scroll, and that failed updates restore the working preview.
- Use the lifecycle suite for main-process behavior and the Electron suite for browser and installer integration.
