---
paths:
  - "packages/**"
  - "scripts/**"
  - "host/instances/**"
  - "host/project/bundle-toolchain.ts"
  - "package.json"
  - "package-lock.json"
  - ".github/workflows/**"
---

# Builds and distribution

- Build the runtime and packager archives from the checked-in package manifests. Keep their versions, dependency pins, and the generated checkout lockfile consistent.
- Keep downloaded dependencies and build output out of Git. Verify the portable kit on a clean build when changing archive contents or launch paths.
- Run the macOS packaging check when changing signing, native dependencies, or the bundled Node and npm toolchain.
