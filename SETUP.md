# Working on this from another machine

Written for a MacBook, but nothing below is Mac-specific except where noted.

## What to copy

Copy the project folder **except** these, all of which are regenerated:

```
node_modules/                    mobile/node_modules/
dist/                            mobile/dist/
mobile/android/app/build/        mobile/android/.gradle/
```

`.gitignore` already lists them.

**Do not copy `node_modules`.** `ffmpeg-static`, `ffprobe-static`, `sharp` and
`electron` all ship **different binaries per platform**. A copied tree looks
complete and then fails at runtime, which is a worse failure than a missing one.

Everything else — including `.supabase/hikari.json` — should come across. It
holds the project URL and the **anon** key, which is public by design (row
level security is what actually guards the data). It is gitignored so it does
not end up in a public repo, but it must exist on the new machine or sign-in
will not work.

Three files carry the same credentials and must agree:

- `src/index.html` (CSP `connect-src` needs the Supabase host)
- `src/sync-config.js`
- `mobile/src/config.js`

## Prerequisites on the Mac

| | why |
|---|---|
| **Node 20+** | Node 24 here; `scripts/clean-dist.mjs` and the tests need modern Node |
| **Xcode Command Line Tools** | `xcode-select --install` — native module builds |
| **Android Studio** | only if you build the APK; provides the SDK **and** a JDK |

## First run

```bash
npm install && (cd mobile && npm install)
```

Then:

```bash
npm start
```

## Building

`npm run dist` builds for whatever OS you are on. Explicit targets exist too:

```bash
npm run dist:mac
```

This produces a **DMG for arm64 and x64**. It is unsigned, so the first launch
needs right-click → Open (or `xattr -dr com.apple.quarantine`). Signing needs an
Apple Developer account; say the word and I will wire notarisation in.

`npm run dist:win` still exists but only works from Windows — NSIS installers
cannot be produced on macOS.

The `predist` hook clears old installers first, so `dist/` will not grow to
2 GB again.

## Android

```bash
cd mobile && npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
```

`JAVA_HOME` must point at a JDK. With Android Studio installed:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

On Windows it lives at `C:\Program Files\Android\Android Studio\jbr`. On macOS
`gradlew` may need `chmod +x gradlew` once — Git does not always preserve the
executable bit across a Windows checkout.

The APK ships **debug-signed**: there is no signing config in `build.gradle`,
and `assembleRelease` produces an unsigned APK that will not install.

## Your library data does not travel with the code

The library lives in Electron's userData directory, not the project:

- **Windows** — `%APPDATA%\Hikari\library.json`
- **macOS** — `~/Library/Application Support/Hikari/library.json`

Two options:

1. **Sign in.** Library, progress and settings sync through Supabase, so a fresh
   install pulls everything down. This is the intended route.
2. **Copy `library.json` across** for an instant, offline-identical shelf.

`settings.json` sits beside it and holds `mediaRoots` — **local file paths**,
which will be wrong on the Mac. Re-point them in Settings after moving.

## Tests

```bash
node --test test/*.test.ts        # in ../zoetrope — the grouping rules
```

Node runs TypeScript directly, so there is no build step.

## Known platform differences

- **Local playback** shells out to the bundled `ffmpeg`. The macOS binary
  installs automatically with `npm install`.
- **Remote play** binds `0.0.0.0:8971`. macOS will prompt for a firewall
  exception on first run; accept it or the phone cannot reach the desktop.
- `scripts/clean-dist.mjs` matches `Hikari-Setup-*.exe`. On macOS the artefact
  is `Hikari-*.dmg` — the patterns in that file need extending if you want it
  cleaning DMGs too.
