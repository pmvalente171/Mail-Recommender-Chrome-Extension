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
- `createAssistant` inserts a host element **before** the reply's editable body (never inside it: anything inside becomes part of the email) and renders the UI into its shadow root from a state object, like the prototype: ready bar → "Mostrar assistente" chip, or progress steps → the list panel. The content is still the prototype's static `EXAMPLE_LIST`.
- Layout is driven by `data-dalm-*` attributes and a page stylesheet (`injectPageStyles`): in `side` mode the panel is absolutely positioned on the right and the editable gets `padding-right` + `min-height`; when the reply body is narrower than `NARROW_BELOW` the panel goes above the text (`top` mode). Only attributes on Gmail's elements are touched, never their content.
- `isolateEvents` stops key and click events at the shadow host, because Gmail's keyboard shortcuts would otherwise fire while typing in the panel.
- Preferences (`guideSeen`, `prepareAlways`) are kept in `chrome.storage.sync`. Public Sans is bundled in `public/fonts/` (OFL) and exposed through `web_accessible_resources`.

Not built yet (later steps): reading the thread and calling the backend (`/list`, `/generate`, `/config`, `/log`, mocked first, via the service worker), personal-data redaction, inserting text into the email, per-thread state, study logging.

### 2. React popup (`src/`)
Compiled by CRA into `build/static/`. Mounted by `build/index.html`, shown when the user clicks the extension icon. Currently a static informational UI. Extend `src/App.js` for settings, status, or configuration controls.

### 3. Service worker (`public/ServiceWorker.js`)
Minimal background script. Runs as an ES module (`"type": "module"` in `manifest.json`). Add `chrome.runtime.onMessage` listeners here if the popup or content script need to communicate through the background.

### Key constraint: two separate JS environments
`content.js` and the React popup cannot share modules — they run in separate contexts. Communication between them must go through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, routed through the service worker if needed.

### Loading the extension
Point Chrome at the **`build/`** folder (not the repo root). The `public/` folder is source; `build/` is what Chrome loads.
