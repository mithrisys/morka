# @morka/packager

The packaging CLI for Morka apps and Shadows. Generated projects use this package as a development dependency alongside the matching version of `@morka/runtime`.

From an app repository, run `npm run build` to create a launcher for the checkout. On macOS, run `npm run package:mac` to build a self-contained application bundle under `dist/`.

From a Shadow repository, use `morka-pack shadow-validate` to check its contents and `morka-pack shadow-pack` to create a distributable archive.

[Morka documentation](https://github.com/mithrisys/morka#readme)
