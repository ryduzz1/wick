# Releasing

Wick is packaged with [electron-builder](https://www.electron.build). The configuration is the `build` field in `package.json`; `scripts/dist.mjs` builds the engine first and decides whether to sign.

## What a build contains

- The app (`app/`, `bin/`, `sdk/`, `testbench/`, `package.json`) in `app.asar`. Wick has no runtime npm dependencies.
- `Resources/wick-engine` (`wick-engine.exe` on Windows), the release engine build, found by `enginePath()` through `process.resourcesPath`.
- `Resources/examples/`, the example macros.
- `Resources/bin/wick` (`wick.cmd` on Windows): the CLI, which runs `bin/wick.js` with the app's own Electron acting as Node. On macOS, link it onto your PATH with `ln -s /Applications/Wick.app/Contents/Resources/bin/wick /usr/local/bin/wick`; Settings shows the exact path. Macro folders' `AGENTS.md` and `.mcp.json` point at the same executable, so agents work without Node installed.
- The `wick://` URL scheme and the `.wick` document type (Info.plist on macOS, registry entries from the NSIS installer on Windows). The app claims `wick://` at runtime only when packaged, so development runs never change the system's handler.

## Local builds

```sh
npm run dist:dir     # unpacked app in dist/, quick to try
npm run smoke:dist   # the app smoke test and the bundled CLI, against that build
npm run dist         # dmg + zip on macOS, NSIS installer + zip on Windows
```

Builds are for the machine's own architecture (the engine binary is native). Without signing credentials the build is unsigned: on macOS, open it with right-click → Open the first time, and expect Screen Recording and Accessibility to be asked for again after each rebuild, because macOS ties those permissions to the signature.

## Signing (needs the maintainer)

These need accounts and certificates only the maintainer has, so they aren't automated yet:

**macOS:** an Apple Developer account ($99/year) and a **Developer ID Application** certificate.

- Locally: with the certificate in your keychain, set `CSC_NAME="Developer ID Application: Your Name (TEAMID)"` and run `npm run dist`. electron-builder signs with the hardened runtime.
- Notarizing: also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com) and `APPLE_TEAM_ID`.

**Windows:** a code-signing certificate (an OV/EV certificate or Azure Trusted Signing). Without one, SmartScreen warns on first run; the build still works.

## Publishing with GitHub Actions

`.github/workflows/release.yml` builds on macOS and Windows, runs the tests and the packaged smoke test, and uploads the installers as workflow artifacts.

- **Try a build:** Actions → Release → Run workflow. Unsigned builds appear as artifacts.
- **Release:** bump `version` in `package.json`, commit, then tag and push (`git tag v0.2.0 && git push origin v0.2.0`). The workflow uploads the builds to a **draft** GitHub release; check it and publish it by hand.
- **Signing in CI:** add these repository secrets and the same workflow signs and notarizes: `MAC_CERTIFICATE` (the .p12, base64), `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CERTIFICATE` (.pfx, base64), `WIN_CERTIFICATE_PASSWORD`.

## Updates

Wick checks the latest GitHub release once per launch (packaged builds only) and shows a notice in the sidebar when a newer version is out; Settings and Help have a manual check. The notice links to the release page and the user installs the new version themselves. Macros, settings and calibration live in the user's library and app data, so they carry over.

Silent in-place updates (electron-updater) are left for later: on macOS they require a signed build, so they wait for the Developer ID certificate.

## Checklist

1. `npm run check`, `npm test`, `npm run test:engine`, `npm run smoke:app`.
2. `npm run dist:dir && npm run smoke:dist` on macOS; the Release workflow covers Windows.
3. Bump the version, update `docs/ROADMAP.md`, tag, push, check the draft release's files, publish.
