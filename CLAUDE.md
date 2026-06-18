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

Core flow:
- A `MutationObserver` watches the Gmail DOM for compose boxes (`div[role="textbox"][aria-label]`).
- `attachToComposeBox` injects a **"Draft reply" button** into each new compose box (guarded by `dataset.mailRecommenderAttached` to avoid double-attaching). The backend (`agent/server.py` + `DALMRecommender`) runs a multi-step LLM + retrieval pipeline that takes several seconds and only replies in European Portuguese, so this is an explicit, on-demand action rather than a live-as-you-type suggestion.
- Clicking the button POSTs `{ email: text }` to `RECOMMEND_ENDPOINT` (`http://localhost:4000/recommend`) and expects `{ in_scope: bool, reply: string, ... }` back.
- If `in_scope` is true, the compose box content is replaced with `reply`, then a synthetic `input` event is dispatched so Gmail registers the change. If not in scope (or the request fails), a dismissible notice tooltip (`#mail-recommender-notice`) is shown near the button instead. **Esc** dismisses the notice.

To change the backend URL, update `RECOMMEND_ENDPOINT` at the top of `public/content.js`.

### 2. React popup (`src/`)
Compiled by CRA into `build/static/`. Mounted by `build/index.html`, shown when the user clicks the extension icon. Currently a static informational UI. Extend `src/App.js` for settings, status, or configuration controls.

### 3. Service worker (`public/ServiceWorker.js`)
Minimal background script. Runs as an ES module (`"type": "module"` in `manifest.json`). Add `chrome.runtime.onMessage` listeners here if the popup or content script need to communicate through the background.

### Key constraint: two separate JS environments
`content.js` and the React popup cannot share modules — they run in separate contexts. Communication between them must go through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, routed through the service worker if needed.

### Loading the extension
Point Chrome at the **`build/`** folder (not the repo root). The `public/` folder is source; `build/` is what Chrome loads.
