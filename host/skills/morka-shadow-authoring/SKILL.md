---
name: morka-shadow-authoring
description: Create, update, or validate a portable Morka Plugin Shadow package containing a persistent project rule, an adaptation skill, and optional examples or assets.
---

# Author a Plugin Shadow

Treat the requested behavior as the package's rule for projects that import it, including phrases such as “from now on.” The draft root is this independent repository's `shadow/` directory. Write package files relative to that root with `apply_patch`. Use the app's Shadows panel to install the package when it is ready.

## Package contract

Put `manifest.json` at the package root. Use JSON with the field names below. Include `assets` and `examples` only when the package includes them.

```json
{
  "id": "ui-conventions",
  "version": "1.0.0",
  "description": "Apply shared interface conventions.",
  "skills": "skills/ui-conventions/SKILL.md",
  "rules": "rules/ui.md",
  "assets": ["media/palette.svg"],
  "examples": ["examples/component.css"]
}
```

- Use an ID of 1–63 lowercase ASCII letters, digits, or hyphens, starting with a letter or digit. Keep the ID when revising an existing package and choose a new version for the revision, such as `1.1.0`. Use a nonempty description of at most 1,000 characters.
- Resolve every listed path relative to the package root. Use separate files for `skills` and `rules`. Every listed path must point to an existing, nonempty regular file inside the package. Keep the manifest and each text entry at or below 32 KiB and the total referenced package size at or below 32 MiB.
- Put the lasting convention in the rule. State its intended scope and what it requires in future edits, including when its target is absent at import and added later.
- Give `SKILL.md` YAML frontmatter with `name` and `description`. Use the skill body to explain how the importing agent should identify the target in the actual project, adapt to its layout and conventions, and verify the result. Ask a focused question when multiple plausible targets would lead to different changes.
- Use `examples` for optional text snippets the agent can adapt and `assets` for files the package supplies. List only files owned by the package. Prefer a self-contained rule and skill with any essential details in their own files.

Before delivering, check the manifest against the files you created and confirm that the rule and skill describe the same behavior. Summarize what the Shadow will do when installed.
