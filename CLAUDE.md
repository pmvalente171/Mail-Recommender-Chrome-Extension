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
- `createAssistant` appends a host element to `<body>` (never inside the reply: anything inside the editable becomes part of the email) and renders the UI into its shadow root from a state object, like the prototype: the "Quer ajuda?" card → "Mostrar assistente" chip, or progress steps → the list panel.
- The UI floats like LanguageTool (`position()`, host is `position: fixed`). Collapsed, it is a round badge (`renderBadge`) at the reply's top-right corner that opens into "Mostrar assistente" on hover/focus and shows the number of points still to do; the "Quer ajuda?" card drops from the same corner. Both stick to the top of the visible part of the conversation (`scroller`) and hide when the reply is out of view. The panel (steps, list, editing) docks to the right edge of the window below Gmail's top bar; it can be dragged by its header (`panelSpot`, kept until the page reloads, clamped to the window) and double-clicking the header docks it again. Position reruns on scroll, resize and a 1 s poll. Gmail's layout is never changed, so the person's text never moves. Earlier versions reserved space with padding on Gmail's elements; that made the text jump and got clipped by Gmail's `overflow: hidden` containers, so don't go back to it.
- `render()` rebuilds the shadow root's HTML on every state change, so it carries over what a rebuild would lose: the list's scroll position on the same screen (`lastScreen`), and focus and cursor in a field (restored with `preventScroll`). Opening animations play only when something actually opens: the panel or card (`lastShown` → `.enter`), a step (`openingId` → `.opening`), the Mais menu (`moreOpening`). Closing ones go through `leaveThen` (`.leaving`, `LEAVE_MS`). All are off under `prefers-reduced-motion`.
- "Preparar a lista" (`askList`) is the only place the thread is read: `requestList` calls `readThread`, removes personal data with `redact` (patterns in `REDACTIONS`, plus the senders' names; other names are a known gap), hashes the thread ID into `ticket`, and sends `{ thread, ticket }` to the service worker. `runWork` animates the progress steps until the response arrives, with an error state and "Tentar outra vez".
- The list is the "Plano de resposta" (`renderPoint`: one line per step with a numbered circle in its colour, the title and the description underneath; `openId` expands one to show its sources, the Você/Assistente choice `setOwner` and a ↳ line). "Editar" switches it to in-place editing (`S.editing`, `renderPointEdit`/`renderNewStep`: title and description fields, ⊖ `removePoint`, ⊕ via the form's submit; "Anular" restores `S.snapshot`). Each point has an `owner` (`'ai'` | `'user'`, suggested by `/list`) and a derived status (`pointState`: todo, writing, ask, slot, done) shown as an icon that is never clicked. There is no confirmation step: the assistant's points are done once written (unless values are missing); the person's are done when they type in their slot (or mark it in the opened line). Missing values for the assistant's points are asked once in the "Falta saber" block (`aiNeeds`/`renderNeeds`). An opened line also shows the past answers behind the point (`renderSources`, from `/list`'s `source_ids` and `source_details`, kept as `sourceIds`/`sourceDetails`). The footer has one main button, "Escrever a resposta" (`writeReply`), plus a "Mais" menu (`moreOpen`). This replaces the spec's original tick-to-skip design and the later Cocoa-style toggles: see `HANDOFF.md` sections 14.1 and 14.3, and `docs/REDESIGN_PLAN.md`.
- `writeReply` sends only the assistant's points to `/generate` (with the redacted thread and ticket kept from `/list`, the other points as `context_points`, and `previous` for "Escrever outra versão"), and adds a slot (`placeSlot`, text from `TEMPLATE.slot`) for each of the person's points, all in plan order. If there are no assistant points, it only lays out slots, with no backend call.
- Linked colours (REDESIGN_PLAN E4): each point has a colour (`colorOf`, `PALETTE`), shown as a dot in its line and as bars/outlines drawn by `drawMarks` in a transparent `marks` layer (fixed, `pointer-events: none`, clipped to the conversation) over the sections in `blocks`. `position()` runs both `placeHost()` and `drawMarks()`, so marks follow scrolling, resizing and typing. `setHover` links hover both ways (panel row ↔ email section); opening a row calls `scrollToSection`.
- Reminder at Enviar (open issue 9): hovering or focusing Gmail's send button (`sendButtonFrom`, matched by its `data-tooltip`) shows how many `[placeholders]` and untouched slots remain (`pendingInEmail`). It never blocks sending.
- The assistant's text goes into the email as plain `<div>` lines, one paragraph per point in list order, above Gmail's signature and quoted text (`GMAIL_TAIL`). If the reply was empty, a greeting with the requester's name, a thanks line and a sign-off (`TEMPLATE`) are added locally. Each paragraph and slot is tracked in `blocks` (`kind: 'ai' | 'slot'`) with the text it was written with: while unchanged an assistant paragraph is refilled as values are typed (`refillParagraphs`, values never leave the browser) and replaced by "Escrever outra versão"; once the person edits it, only its remaining `[placeholders]` are filled. `syncWithEmail` (on every input in the reply) resets a point whose paragraph or slot was deleted and completes a point whose slot was typed in. Removing the assistant's text keeps slots the person wrote in. `tellGmail` dispatches `input` so Gmail saves the draft.
- Icons are inlined in `ICON_SHAPES` from `public/icons/*.svg`; edit the SVG files, then copy the shapes.
- `isolateEvents` stops key and click events at the shadow host, because Gmail's keyboard shortcuts would otherwise fire while typing in the panel.
- Preferences (`guideSeen`, `prepareAlways`) are kept in `chrome.storage.sync`. Public Sans is bundled in `public/fonts/` (OFL) and exposed through `web_accessible_resources`.

Not built yet (later steps): per-thread state, `/config` (hiding generation in list-only phases), study logging (`/log`), send detection, and undo for removing the assistant's text (open issue 2).

### 2. React popup (`src/`)
Compiled by CRA into `build/static/`. Mounted by `build/index.html`, shown when the user clicks the extension icon. Currently a static informational UI. Extend `src/App.js` for settings, status, or configuration controls.

### 3. Service worker (`public/ServiceWorker.js`)
Runs as an ES module (`"type": "module"` in `manifest.json`). It is the **only** part that talks to the backend (`BACKEND_URL`): the content script sends `{ type: 'dalm:list' | 'dalm:generate', payload }` messages (mapped to endpoints in `ROUTES`) and gets `{ ok: true, data }` or `{ ok: false, error }` back.

The backend lives in a separate repo (DALM-Chatbot, Flask in Docker) and implements the contract in `docs/BACKEND_SPEC.md`, the shared source of truth between the two repos: agree changes with the backend owner before editing it. `BACKEND_URL` (`http://localhost:4000`, through an SSH tunnel on the cluster) must stay in sync with `host_permissions` in `manifest.json`, which lets the service worker call it without CORS. Calls take 30–95 s: `postJSON` aborts after `REQUEST_TIMEOUT_MS` (150 s) and pings an extension API every 20 s so Chrome doesn't stop the idle service worker mid-request.

`MOCK_BACKEND = true` answers from canned data instead (a thread containing `!erro` simulates a failure, `!vazio` an empty list). Requests and responses are logged to the service worker's console (chrome://extensions → "service worker"), which is how to check the redaction and the backend's output.

### Key constraint: two separate JS environments
`content.js` and the React popup cannot share modules — they run in separate contexts. Communication between them must go through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, routed through the service worker if needed.

### Loading the extension
Point Chrome at the **`build/`** folder (not the repo root). The `public/` folder is source; `build/` is what Chrome loads.

After reloading the extension, **refresh the Gmail tab** too: the content script already running there is cut off from the extension (`chrome.runtime` goes away). `extensionAlive()` makes that orphaned copy stop quietly (the observer disconnects, and a click shows "A extensão foi atualizada. Recarregue o Gmail para continuar.") instead of throwing errors.
