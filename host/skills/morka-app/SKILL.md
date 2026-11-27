---
name: morka-app
description: Create or edit the Morka project's interface, runtime, services, and project instructions.
---

# Edit a Morka project

Start with the project manifest used by the current draft. Apps use `morka.project.json`. Read `project_files` for editable file contents, `project_paths` for the file inventory, and `project_instructions` for the project's active rules and skills, including imported Shadows. Follow the existing layout. Use native `apply_patch` in the project draft. Morka validates the draft, then publishes its changes. If paths move, update their references in the manifest.

Implement the requested change in the current turn. Save the edits and finish the turn so Morka can run the preview checks and show the result. Morka handles screenshot review after an ordinary edit has been applied.

For a standard Morka Git repository, the draft root corresponds to `app/`. Edit paths relative to the draft root. The outer repository owns `README.md`, `AGENTS.md`, `package.json`, `package-lock.json`, Git metadata, and `.morka/`. Keep those outer files intact. The app has its own editable package.json and package-lock.json inside this draft (app/ in the repository); declare arbitrary app dependencies there. Keep assets and services inside the draft.

Use the app's Shadows panel to install or remove a Shadow. Direct package authoring to New Shadow or Open Shadow so it uses the independent package repository.

## Build the first useful workflow

Infer the user's intended outcome and choose one real task they can finish end to end. For a new notes app, that might mean write a note, extract commitments, correct one, save it and find it after reopening. Implement the requested scope. Pick reversible defaults yourself. Ask when an unresolved choice changes the outcome, ownership of data or an external effect. Treat explicitly requested technology, architecture, accessibility and persistence as acceptance criteria on later edits too.

Use the existing app structure. Keep a small feature together until it needs a separate boundary. Store durable app data in MORKA_DATA_DIR. Use stable control IDs and preserve edits, route and focus through live updates. Keep user-specific integrations inside the app. Morka handles installation, build and publication. Report what the user can now do and which checks actually ran.

Read the relevant built-in guides listed with this skill. For a new feature, use design and engineering guidance. For UI-only polish, change the linked stylesheet when sufficient. Leave behavior tests and preview scenarios alone when their expectations are unchanged. For a new workflow, author morka.preview.json and fast tests for success and a meaningful failure. For an explicit full review, use the host's /review command or create/update the scenario when the app lacks one.
