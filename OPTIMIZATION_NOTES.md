# Build-size optimizations

This revision minimizes the packaged application without removing Google Voice calling/media support.

## Runtime dependency reductions

Only `electron-updater` remains as a production dependency.

- Replaced `electron-store` with `src/utils/preferencesStore.js`. It intentionally reuses the existing `config.json` location so current settings continue to load.
- Replaced `auto-launch` with Electron's native Windows/macOS login-item APIs plus a small Linux autostart helper.
- Replaced `electron-context-menu` with a small local context-menu implementation.
- Moved `sass` to `devDependencies`. Theme SCSS is precompiled before packaging and only compiled on demand during development.

## Packaging reductions

- ASAR enabled.
- Maximum electron-builder compression enabled.
- Only the `en-US` Electron locale is retained.
- SCSS source, source maps, TypeScript declarations, node-module Markdown, docs, and benchmarks are excluded from the packaged app.
- Native dependency rebuilding is disabled because the production dependency tree contains no native add-ons.
- The Windows ICO was rebuilt from the existing icon with efficient PNG-backed sizes (16 through 256 px), reducing the build resource from roughly 264 KB to roughly 35 KB.

## Windows build choices

`pnpm build:windows`
: Optimized offline NSIS x64 installer. This remains relatively large because it contains Electron/Chromium.

`pnpm build:windows:web` or `pnpm build:windows:small`
: NSIS Web installer. The visible setup `.exe` is dramatically smaller because the Electron payload is downloaded during installation. The total bytes ultimately downloaded are still close to the offline payload size.

`pnpm release:windows:web`
: Publishes the web installer and package payload using the configured GitHub provider.

`pnpm size:windows`
: Reports the largest files under `dist/win` after a build.

All build/release scripts that create a new package automatically increment the patch version first.
