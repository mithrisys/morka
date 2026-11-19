# Changelog

Release entries describe user-visible changes and upgrade steps, newest first.

## 0.2.2 (2026-11-19)

- New app and Shadow repositories install exact versions of the runtime and packager from npm. Their generated lockfiles record the registry URLs and integrity hashes, so the repositories no longer need to include package archives.
- To upgrade an existing app, install `@morkaai/runtime@0.2.2` as an exact dependency and `@morkaai/packager@0.2.2` as an exact development dependency. Commit the updated manifest and lockfile together.
