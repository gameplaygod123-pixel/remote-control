# Personal Remote

A personal AnyDesk/TeamViewer-style remote-desktop tool, built from scratch:
one machine (**Controller**) views and controls another (**Agent**) over the
internet via WebRTC. Electron + React + TypeScript, pnpm workspace monorepo.

Repo: https://github.com/gameplaygod123-pixel/remote-control (public)
Latest release / installer: https://github.com/gameplaygod123-pixel/remote-control/releases/latest

## If you're an AI assistant reading this for the first time

Read **`docs/architecture.md`** before making changes -- it's a running log of
every decision, bug, and gotcha found while building this app (why things are
structured the way they are, what was tried and didn't work, security
decisions, etc.). Skipping it risks re-doing work or re-introducing already-
fixed bugs.

## Setup on a new/different machine

```
git clone https://github.com/gameplaygod123-pixel/remote-control.git
cd remote-control
pnpm install
```

Don't copy the old machine's `node_modules/` or `dist/` folders over --
`node_modules` contains native bindings (nut.js, for mouse/keyboard control)
built for a specific OS/architecture, and `pnpm install` regenerates the
right ones for the new machine automatically. `dist/` is just build output,
safe to regenerate.

See `docs/architecture.md`'s "Running locally" section for how to run the
agent, controller, and signaling server in dev mode.

## Building and releasing a new version

From `apps/desktop`:

```
# bump "version" in apps/desktop/package.json first -- the installer
# filename and the GitHub release tag both follow it automatically
GH_TOKEN=$(gh auth token) VITE_SIGNALING_URL="wss://<current-tunnel-url>" pnpm release:win
```

This builds the Windows installer and publishes it straight to GitHub
Releases (live, not draft -- see `electron-builder.yml`). Anyone with the
app installed gets it automatically within 6 hours, or immediately if they
click "Check for updates" in the app.

## When the signaling tunnel URL changes

Installed builds (v1.13.0+) fetch the current signaling URL from
`signaling-url.json` at this repo's root on every (re)connect, so a
Cloudflare quick-tunnel restart does NOT require a rebuild or re-release:

1. Edit `signaling-url.json` with the new `wss://...` URL
2. Commit and push to `main`

Every machine picks it up automatically on its next reconnect attempt
(raw.githubusercontent.com caches for ~5 minutes, so allow a few minutes).
The `VITE_SIGNALING_URL` baked at build time is now only the fallback for
when GitHub itself is unreachable -- still set it when releasing.
