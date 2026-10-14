# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm run build      # compile React popup → build/; required before loading into Chrome
npm test           # run Jest tests (watch mode)
npm test -- --watchAll=false  # run tests once (CI-style)
```

After every `npm run build`, reload the extension in `chrome://extensions` (click the refresh icon) for changes to take effect.

## Architecture

This is a Manifest V3 Chrome extension with two independent runtime contexts:

### 1. Content script (`public/content.js`)
Runs directly inside the Gmail page (`mail.google.com`). It is **plain JavaScript — no React, no build step**. The file in `public/` is copied verbatim into `build/` by CRA.

It implements the "Assistente DALM" described in `docs/handoff/HANDOFF.md` (spec, wins over the prototype) and `docs/handoff/prototype.html` (look and behaviour). Work follows the spec's build order (section 11) one step at a time; read the spec's non-negotiable rules (section 2) before changing behaviour.

Core flow:
- A `MutationObserver` watches the Gmail DOM for editable boxes (`div[role="textbox"][aria-label]`).
- `findThreadView` limits attaching to inline replies inside an open thread (`[role="main"]` containing `.a3s` message bodies); new messages from "Compor" are ignored. `readThread` reads the expanded messages (sender, date, body text) plus the thread ID, and must only be called after an explicit click.
- `createAssistant` inserts a host element **before** the reply's editable body (never inside it: anything inside becomes part of the email) and renders the UI into its shadow root from a state object, like the prototype: ready bar → "Mostrar assistente" chip, or progress steps → the list panel.
- `layout()` positions the host absolutely over the editable (its parent gets `position: relative`) and makes room so the person's text starts clear of it. In `top` mode (bar, chip, narrow panel) the editable gets inline `padding-top`. In `side` mode the **parent** gets `padding-right` and the editable `min-height`. Never put horizontal padding on the editable: Gmail sizes it at 100% of its parent, so it overflows and an outer `overflow: hidden` container (`div.qz`) clips the panel. Gmail's own flow layout also can't be relied on to push the text down. Only inline styles change, never the editable's content.
- "Preparar a lista" (`askList`) is the only place the thread is read: `requestList` calls `readThread`, removes personal data with `redact` (patterns in `REDACTIONS`, plus the senders' names; other names are a known gap), hashes the thread ID into `ticket`, and sends `{ thread, ticket }` to the service worker. `runWork` animates the progress steps until the response arrives, with an error state and "Tentar outra vez".
- Each point has an `owner` (`'ai'` | `'user'`, suggested by `/list`, switched with the owner toggle) and a derived status (`pointState`: todo, writing, ask, review, done) shown as an icon that is never clicked. The person marks points done with Feito / Confirmar and undoes with Desfazer; the assistant never marks anything done. "Gerar os pontos do assistente" (`writePoints`) only writes points owned by the assistant, in place with spinners; it is simulated (`MOCK_WRITE_MS`) until `/generate` exists. This replaces the spec's original tick-to-skip design: see `HANDOFF.md` section 14.
- Icons are inlined in `ICON_SHAPES` from `public/icons/*.svg`; edit the SVG files, then copy the shapes.
- `isolateEvents` stops key and click events at the shadow host, because Gmail's keyboard shortcuts would otherwise fire while typing in the panel.
- Preferences (`guideSeen`, `prepareAlways`) are kept in `chrome.storage.sync`. Public Sans is bundled in `public/fonts/` (OFL) and exposed through `web_accessible_resources`.

Not built yet (later steps): `/generate` and inserting text into the email, per-thread state, `/config`, study logging (`/log`).

### 2. React popup (`src/`)
Compiled by CRA into `build/static/`. Mounted by `build/index.html`, shown when the user clicks the extension icon. Currently a static informational UI. Extend `src/App.js` for settings, status, or configuration controls.

### 3. Service worker (`public/ServiceWorker.js`)
Runs as an ES module (`"type": "module"` in `manifest.json`). It is the **only** part that talks to the backend (`BACKEND_URL`): the content script sends `{ type: 'dalm:list', payload }` messages and gets `{ ok, list }` or `{ ok: false, error }` back.

`MOCK_BACKEND = true` (the default while the backend doesn't exist) answers from canned data shaped like the `/list` contract in `HANDOFF.md` section 4. A thread containing `!erro` simulates a failure, `!vazio` an empty list. The mock logs what it receives to the service worker's console (chrome://extensions → "service worker"), which is how to check the redaction. Calling the real backend will also need `host_permissions` for its URL in `manifest.json`.

### Key constraint: two separate JS environments
`content.js` and the React popup cannot share modules — they run in separate contexts. Communication between them must go through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, routed through the service worker if needed.

### Loading the extension
Point Chrome at the **`build/`** folder (not the repo root). The `public/` folder is source; `build/` is what Chrome loads.
