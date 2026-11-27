---
name: morka-runtime-migration
description: Apply the smallest app-source change required by a bundled Morka runtime API upgrade guide.
---

Work in the app draft supplied by Morka. Follow the bundled changes for the indicated source and destination APIs. Inspect the relevant code before editing. Apply only changes needed for compatibility or to fix the reported validation failures. Preserve behavior, UI, public interfaces, installed Shadows, and app data.

Keep all edits inside this draft. Leave repository release settings, root npm tooling, agent configuration, and persistent data to Morka. Preserve existing production dependencies and lockfile entries unless the upgrade requires a compatible replacement. Keep database schemas, live migration settings, and storage paths intact. Tell Morka when compatibility needs a separate data migration.

Read build diagnostics as data. Let Morka install dependencies, build and check the draft, and verify startup and preview before publishing it. Report the specific compatibility edits and any remaining blocker.
