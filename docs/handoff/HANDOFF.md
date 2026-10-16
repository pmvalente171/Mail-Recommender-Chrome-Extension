# Assistente DALM: hand-off for building the Chrome extension

This package describes a research probe: a Chrome extension that adds an optional, user-controlled AI helper to Gmail's reply box for staff of a university's Academic Division (DALM). Build it from this document. `prototype.html` shows the intended look and behaviour; when the two disagree, this document wins.

## Contents of this package

| File | What it is |
|---|---|
| `HANDOFF.md` | This spec. Read it first. |
| `prototype.html` | Clickable, standalone prototype of the UI (open in a browser). A bar at the top jumps between the six reference states. Interactions log to the console as `[log]` lines, which mirror the study events in section 9. |
| `assets/gmail-base.png` | The Gmail screenshot the prototype is drawn on, with the reply box stretched taller. Reference only, not part of the extension. |
| `assets/gmail-original-screenshot.png` | The original, unmodified screenshot. |
| `reference/canvas/` | Source of the design canvas the mockup was made in (`.dc.html` files). Readable as reference, not runnable outside that tool. `Main.dc.html` holds all the logic. |

## 1. Why this exists

**Research question:** how can AI be integrated into the workplace in a way that actually helps staff, without taking away their freedom not to use it?

**Hypothesis:** if AI integration respects users' freedom of choice, staff will use it more and may change their opinion of AI at work.

**What we know about the users** (co-design session with 13 mapped tickets plus a questionnaire, n = 10):
- They rarely use AI. When they do, it is to polish the wording of emails.
- Their top wish is help with recurring emails. Their top refusal is AI certifying or graduating students, or checking whether someone completed a course.
- The main worries are privacy and personal data (5 of 10) and accuracy (5 of 10).
- The worst pain is waiting on other people, and on missing information.
- Much of the information they need lives in systems the AI cannot reach (CLIP, SinGAP, Gesdoc) or in people's heads.

**This is a technology probe**, not a product. Keep it simple, open to unexpected uses, and fully instrumented. Do not add features beyond this spec.

## 2. Non-negotiable rules

1. **The AI only runs when the person clicks.** Nothing is read, sent to a model or generated without an explicit click. The single exception is the opt-in "Preparar esta lista sempre que abro uma resposta" preference, which the person turns on themselves.
2. **Nothing is sent without the person.** The extension never clicks Send and never acts in CLIP, SinGAP or any other system.
3. **Only the person ticks points.** A tick means "this point is dealt with". The AI never ticks anything, including after it writes a point.
4. **Generation only writes unticked points.** "Gerar resposta" or "Gerar o que falta (N)" writes the points that are neither ticked nor already written by the AI.
5. **The assistant says what it does not know.** Information it could not find is shown as a labelled field under the point that needs it, and as a blank in the text, never as a guess.
6. **Values the person types are inserted locally.** They are never sent to the model.
7. **Personal data is removed in the browser before anything reaches the backend:** student numbers, emails, NIF, IBAN/NIB and phone numbers, by pattern. Names are harder to catch; document that limitation.
8. **Declining is always possible and always reversible.** "Não, obrigado" and "Esconder" leave a small "Mostrar assistente" button.
9. **The interface is in European Portuguese.** Use the exact wording in section 5.

## 3. Where it lives

- **Host:** Gmail on the web (`mail.google.com`), in the inline reply box of an open thread. Edge runs the same Manifest V3 extension.
- **UI placement:** in the mockup, the panel sits on the right side of the reply box, and the empty-state bar sits at the top of the reply body.
- **Implementation constraint:** Gmail's reply body is a `contenteditable` area, and anything inserted *inside* it becomes part of the email. All extension UI (the bar, the panel, the button) must be injected **outside** the editable body. Options:
  - InboxSDK, a library made for Gmail extensions that provides compose-view hooks.
  - Your own DOM injection next to the compose element, using a MutationObserver to find compose boxes.
  - Chrome's Side Panel API, if placement next to the reply proves too fragile.

  Pick one and note why.
- **Text in the email:** the mockup shows missing information as yellow highlighted spans. In the real build, **do not send formatting**. Insert plain bracket placeholders such as `[n.º de vagas]`, and track them so the panel can count them and fill them in. When the person types a value in the panel, replace the matching placeholder only while it is still untouched. If the person has already edited that sentence, do not overwrite it.

## 4. Architecture

```
Gmail tab (staff member's Chrome)
├─ Content script ─ finds the open thread and reply box; reads the thread text;
│                   removes personal data; renders the bar + panel; inserts text;
│                   detects Send (for edit distance); replaces placeholders locally
└─ Service worker ─ holds preferences + study phase; queues log events;
                    the only part that talks to the backend
        │ HTTPS: redacted text + events only
        ▼
Backend (university-hosted)
├─ POST /list      redacted thread → request summary, points, missing info, outside tasks
├─ POST /generate  redacted thread + points to write (+ optional instruction) → paragraphs with slots
├─ GET  /config    study phase and flags per participant
└─ POST /log       events (section 9)
   └─ the existing reply recommender + an EU-hosted or university-agreed model.
      The API key lives here, never in the extension.
```

### API contracts (suggested)

`POST /list`
```json
// request
{ "thread": "…redacted text…", "participant": "p07", "ticket": "sha256…" }
// response
{
  "request_summary": "um encarregado de educação quer saber se …",
  "points": [
    { "id": "c2", "title": "Vagas", "desc": "dizer quantas vagas há no concurso de 2026/27.",
      "needs": [ { "key": "vagas", "label": "N.º de vagas" } ] }
  ],
  "outside": [ { "id": "o1", "text": "Pedir à equipa do site que publique a página do curso." } ],
  "steps": ["Li o email", "Percebi o pedido", "Procurei a informação nas fontes a que tenho acesso"],
  "sources": ["…names of the sources actually used…"]
}
```

`POST /generate`
```json
// request
{ "thread": "…redacted…", "points": [ { "id": "c3", "title": "…", "desc": "…" } ], "instruction": null }
// response: text is split into plain segments and named slots; the client fills slots locally
{ "paragraphs": [
  { "point": "c3", "segments": [
    { "text": "As provas de ingresso são " }, { "slot": "provas" },
    { "text": " e a nota mínima de candidatura é " }, { "slot": "nota" }, { "text": " valores." } ] } ] }
```

The greeting, a thank-you line and the sign-off can come from a fixed per-user template rather than from the model.

## 5. Screens, states and exact wording

The six reference states are in the prototype's top bar.

### 5.1 First use: guide (state 1)
Shown once on first install. It can be reopened from "Como funciona".
- Eyebrow: **Assistente DALM · opcional**
- Title: **Uma ajuda para não esquecer nada nas respostas**
- Steps:
  1. "Clique em **Preparar a lista**. O assistente diz o que percebeu do pedido e o que a resposta deve tratar."
  2. "Marque os pontos que já tratou. Se faltar informação, preencha-a ou deixe em branco."
  3. "Se quiser, clique em **Gerar o que falta**: o assistente só escreve os pontos por marcar. Leia o texto e marque cada ponto. **Nada é enviado sem si.**"
- Button: **Percebi**

### 5.2 Ready bar (state 2)
Shown at the top of an empty reply body, unless the person has turned on "Preparar esta lista sempre…".
- Title: **Quer ajuda com este pedido?**
- Text: "O assistente pode preparar uma lista do que a resposta deve tratar. Só lê o email se clicar."
- Primary button: **Preparar a lista**. Quiet button: **Não, obrigado**.
- Below the bar: "Ou escreva a sua resposta aqui, como sempre."
- When the person starts typing in the reply, collapse the bar into the "Mostrar assistente" button.

### 5.3 Declined or hidden
A small pill, **Mostrar assistente**, near the top right of the reply box. Clicking it reopens the list if one exists, otherwise the ready bar.

### 5.4 Working (progress steps)
In the panel, steps appear one at a time with a ✓ when done, in the style of a research tool's step list. Each step has a **Cancelar** button.
- Preparing the list: "A ler o email" → "A perceber o pedido" → "A procurar a informação nas fontes a que tenho acesso"
- Generating: "A juntar a lista e a informação que me deu" → "A escrever os pontos por marcar"
- Another version: "A escrever outra versão"

### 5.5 The list (states 3, 4 and 6)
The panel header reads **Assistente DALM**, with the links **Como funciona** and **Esconder**.

Body, top to bottom:
1. **Summary line**, with ✓: "Li o email e preparei esta lista", or after generating "Escrevi os pontos que estavam por marcar". A link **Ver passos** / **Esconder passos** expands the steps plus "Não encontrei N informações (marcadas abaixo)". Show the actual sources here (open issue 5 in section 10).
2. **O pedido:** a one-sentence restatement of what the email asks.
3. **A resposta deve tratar:**, with "X de Y tratados" on the right.
   - Hint before generating: "Marque os pontos que já tratou. O assistente só escreve os que ficarem por marcar."
   - Hint after generating: "Marque cada ponto quando estiver satisfeito com o texto."
   - Each point has a round check button (`role="checkbox"`), then "**Title**: description".
   - Status line under a point:
     - AI wrote it, not yet ticked: "Escrito pelo assistente · leia o texto e marque" (green, row has a light green background)
     - AI wrote it, ticked: "Escrito pelo assistente · revisto por si"
     - Ticked without AI text: "Tratado por si"
   - Missing information: for each need, a label plus a text field with placeholder "não encontrei" (amber until filled). Typing fills the email text live. Hide the fields once the point is ticked and all its values are filled.
4. **Fora do email, faz você:** tasks the AI cannot do, each with the same round check. There is never an AI button here.

Footer:
- Message, at most one, in this priority:
  - Missing info in the text: "Faltam N informações, a amarelo no texto." (amber; singular "Falta 1 informação, a amarelo no texto.")
  - Unreviewed AI points: "Leia o texto do assistente e marque cada ponto."
  - All points ticked: "Tudo tratado. Envie quando quiser." or "Resposta tratada. Falta a tarefa fora do email."
- Primary button, while points remain to write: **Gerar resposta** if none are ticked, otherwise **Gerar o que falta (N)**.
- When AI text exists: **Gerar outra versão** (secondary) and **Retirar texto do assistente** (link). Otherwise: **Editar lista** (link).
- Preference checkbox: "Preparar esta lista sempre que abro uma resposta (fica guardado)". Persist it in `chrome.storage.sync`. Consider moving it into "Como funciona" (open issue 10).

### 5.6 Editing the list (state 5)
- Header: **A editar a lista**, then "Mude o texto, apague ou acrescente pontos. A lista é sua."
- Each point is a text field ("Title: description") with an **Apagar** button.
- A new-point field (placeholder "Novo ponto, ex.: Contacto: indicar a quem perguntar") with **Acrescentar**.
- Footer: **Concluir** and **Cancelar alterações** (restores the list as it was before editing).

## 6. Behaviour rules

- **Ticking:** toggles `done`. It never adds or removes text.
- **Generating:** sends only points with `done = false` and `ai = false`, and marks them `ai = true` when text arrives. It does not tick them.
- **Removing AI text:** "Retirar texto do assistente" removes all AI-written paragraphs and resets those points to `ai = false` and `done = false`. Add undo (open issue 2).
- **Another version:** regenerates the AI-written points only. Points the person wrote are never touched.
- **Values:** stored per key and inserted locally into matching slots. They are never sent to the backend or to the logs. Log the key only.
- **Hiding:** keeps the list and its state for that thread.
- **State per thread:** keep the list, ticks and values per thread for the session, so reopening restores them.

## 7. Data model (client)

```ts
type Need = { key: string; label: string };
type Point = { id: string; title: string; desc: string; needs: Need[]; done: boolean; ai: boolean };
type Outside = { id: string; text: string; done: boolean };
type ThreadState = {
  view: 'ready' | 'declined' | 'working' | 'list';
  requestSummary: string;
  points: Point[];
  outside: Outside[];
  values: Record<string, string>;   // never leaves the browser
  editing: boolean;
};
type Prefs = { prepareAlways: boolean; guideSeen: boolean };
```

## 8. Visual design

The tokens are at the top of `prototype.html`. Summary:
- **Assistant identity:** deep green `#1F5C4A` for primary buttons and badges, light tints `#F2F7F4` and `#EAF3EF`. It is deliberately different from Gmail's blue, so it reads as "the assistant", not Gmail.
- **Ticks:** `#2F8A63`.
- **Missing information:** amber background `#FBE7A1`, line `#B8921C`, text `#5A4400`.
- **Fonts:** Public Sans for the assistant's UI. Text inserted into emails follows Gmail's default font.
- **Size:** controls at least 40–44 px high. Every icon has a text label, except the round checks, which have an `aria-label`.
- **Icon:** a sparkle marks anything the assistant does, always next to a word.

## 9. Study instrumentation

Log metadata only, never email text and never typed values, unless the participant has explicitly consented to text logging.

Every event carries `participant` (pseudonymous ID set at install), `ticket` (SHA-256 of the thread ID), `phase` (from `/config`), `ts`, and `event`.

| Event | Extra fields |
|---|---|
| `bar_shown` | |
| `list_requested` | |
| `assistant_declined` | |
| `panel_hidden` / `assistant_reopened` | |
| `list_shown` | `n_points`, `n_needs` |
| `steps_expanded` | |
| `point_ticked` / `point_unticked` | `point`, `ai` (bool), `seconds_since_generated` |
| `value_entered` | `key` (never the value) |
| `generate_clicked` | `points` (ids), `n_ticked_before` |
| `regenerate_clicked` | |
| `ai_text_removed` | `points` |
| `list_edited` | `added`, `deleted`, `renamed` (counts) |
| `guide_opened` | |
| `pref_prepare_always` | `value` |
| `reply_sent` | `edit_distance_per_point`, `placeholders_left` |

`reply_sent` is computed locally at Send time by comparing the sent text with the AI paragraphs. Only numbers are sent.

**Study phases** (set by `/config`), for example:
- **Phase 1:** list only, with no "Gerar" button.
- **Phase 2:** full assistant.

Final design TBD with the researcher. The extension must hide or show "Gerar" from config.

## 10. Open issues from the heuristic evaluation

Severity runs from 1 (cosmetic) to 4 (critical). Fix 1 and 2 before testing with staff.

1. **(3) Link points to paragraphs.** Clicking a point's text highlights its paragraph in the email, for viewing only, so staff can find what to review.
2. **(3) Undo.** "Retirar texto do assistente" needs an "Anular" message, and each AI-written point needs its own "retirar este".
3. **(2) Ticking to skip.** To skip generating a point they will write later, staff must tick it early. Leave as is and observe in testing.
4. **(2) Correcting the interpretation.** "O pedido" can't be corrected. Add "Não é isto?" to fix the sentence and redo the list.
5. **(2) Sources.** "Ver passos" should list the actual sources used.
6. **(2) Live fill.** Live fill must not overwrite text the person already edited (see section 3).
7. **(2) Two kinds of tick.** System progress ticks and user checks are both green. Make the progress ticks grey if testing shows confusion.
8. **(2) Error states.** Add errors for generation failed, offline, and thread changed, each a short plain message with **Tentar outra vez**.
9. **(2) Send-time reminder.** Decide whether to remind people at Send when placeholders remain. It must not block sending.
10. **(1) Preference placement.** Move the "Preparar sempre" preference out of the footer.

## 11. Build order

Each step is testable on its own.

1. The content script finds an open Gmail thread and its reply box, and reads the thread text.
2. Inject the ready bar and panel outside the editable body. Static content from `prototype.html`.
3. Redaction plus `POST /list` against a mock backend. Render the list.
4. Ticks, missing-info fields, list editing, and per-thread state.
5. `POST /generate`, inserting plain text with `[placeholders]`, and filling placeholders locally.
6. Send detection, edit distance, the logging queue, and `/config` phases.
7. Open issues 1, 2 and 8. Then a pilot with one or two staff, installed unpacked.

## 12. Out of scope

- Sending, archiving, labelling or closing anything automatically.
- Any action in CLIP, SinGAP, Gesdoc or other university systems.
- Reading emails the person has not opened and clicked on.
- Settings beyond the single "Preparar sempre" preference.

## 13. Notes on the example content

The example email is about a parent asking whether the "Licenciatura em Análise e Engenharia de Dados" has places in 2026/27. The values in the prototype's demo states ("30", "Matemática A", "100", the dates) are **invented**. They stand in for what a staff member would type. Never ship them, and never let the model invent such facts: they must come from a source or from the person.

## 14. Changes after the first build

These decisions were made while building and testing in Gmail. Where they conflict with sections 2 to 10, this section wins.

### 14.1 Who handles each point (replaces ticking to skip)

Testing showed the round check was not intuitive: it meant both "this point is dealt with" and "the assistant should not write this", so staff had to tick a point before dealing with it just to keep the AI away from it (open issue 3). Following Cocoa (Feng et al., CHI '26, `documents/COCOA.pdf`), the two meanings are now separate controls:

- **Owner toggle** on each point: you or the assistant (user and robot icons, `role="switch"`). `POST /list` suggests an owner per point (`"owner": "ai" | "user"`, default `"user"`); the person can switch it at any time until the assistant has written that point. Tasks outside the email are always the person's and have no toggle.
- **Status icon**, shown and never clicked: • to do; spinner while writing; amber **?** when an assistant point is missing information; dashed circle when the assistant has written it and it waits for the person; ✓ done.
- **The person's actions** are explicit buttons: **Feito** on their own points, **Confirmar** on assistant-written points, **Desfazer** to undo either.
- A **↳ line** under each point says what happened ("Fica para o assistente", "Escrito pelo assistente · leia o texto e confirme", "Tratado por si", …).

What this changes in the rules:

- **Rule 3** still holds in spirit: only the person marks a point done. The assistant never does, including after writing it; its points stop at "leia o texto e confirme".
- **Rule 4** becomes: generation writes the points **assigned to the assistant** that it has not written yet and that are not done. The button reads **Gerar os pontos do assistente (N)**.
- **Section 6, "Another version"**: rewrites the assistant's points the person has not confirmed yet.
- **Section 7**: `Point` gains `owner: 'ai' | 'user'` and `writing: boolean`.
- **Section 5.4**: generating no longer replaces the list with progress steps; the points being written show a spinner in place, with **Cancelar** in the footer. Preparing the list still uses the progress steps.
- **Missing-information fields** show under the assistant's points only, since their values fill its text. On the person's own points the ↳ line lists what was not found.
- **Study events** (section 9): add `owner_changed` with `point`, `to` (`ai`/`user`) and `suggested` (the backend's suggestion); `point_ticked`/`point_unticked` become `point_done`/`point_undone`.

### 14.2 Placement and layout

- The assistant **floats over Gmail, like LanguageTool**, instead of sitting beside or above the text (replaces section 3's "UI placement" and the ready bar's position in 5.2). Gmail's layout is never changed, so the text never moves; reserving space for the panel made the text jump and the panel got clipped by Gmail's containers.
  - **Collapsed (5.3):** a round sparkle badge at the reply's top-right corner. On hover or keyboard focus it opens into "Mostrar assistente"; once there is a list it shows the number of points and outside tasks still to do. Its accessible name always carries the full label.
  - **Ready (5.2):** the "Quer ajuda com este pedido?" card drops down from the badge's corner when a reply opens; typing collapses it to the badge. Its hint now reads "Ou escreva a sua resposta, como sempre."
  - **Panel (5.4–5.6):** docked to the right edge of the window, full height below Gmail's top bar, 420 px wide. It stays put while the conversation scrolls and overlaps the right of the page until hidden with "Esconder". The person can drag it anywhere by its header (it stays inside the window, and keeps that place until Gmail is reloaded); double-clicking the header docks it again.
  - **Motion:** the badge pops in, the card drops in, the panel slides in from the right and out on "Esconder". Animations play only on opening and closing, and are off when the system asks for reduced motion.
- "Preparar esta lista sempre que abro uma resposta" moved from the panel footer into "Como funciona" (open issue 10, done).
- The small in-row buttons (Feito, Confirmar, Desfazer), the owner toggle and the collapsed badge are 32–36 px high, below the 40–44 px target in section 8, to fit the panel and keep the badge unobtrusive. Revisit if testing shows they are hard to hit.

### 14.3 Simplified after the heuristic evaluation

Pedro's heuristic evaluation rated the interface too complex for the task and for staff new to AI (severity 4); see `docs/REDESIGN_PLAN.md`. Where this conflicts with 14.1, this wins.

- **No confirmation step.** The assistant's points count as done once written (unless values are still missing). Rule 3 becomes: *the assistant never completes the person's points*; the person still reviews everything in the email before sending, and that review is measured by the edit distance in `reply_sent`, not by a click. "Confirmar" is gone.
- **Compact list.** One line per point: status icon, title, a small owner icon. Clicking a line opens it: description, a **Você / Assistente** choice (text-labelled, locked once the assistant has written the point), and a ↳ line. Status icons: • to do, spinner, amber ? (an assistant point with values still missing), dashed circle (a slot waiting for the person's text), ✓ done.
- **"Falta saber".** All the values the assistant could not find, for its own points, in one block above the list, each asked once. Text: "Não encontrei isto. Preencha ou deixe em branco: fica entre [ ] no texto."
- **One next step.** The footer's only main button is **Escrever a resposta** ("Escrever o que falta" once something was written). "Escrever outra versão", "Retirar o texto do assistente" and "Editar a lista" are under **Mais**.
- **Slots for the person's points.** "Escrever a resposta" lays the whole email out in the plan's order: the assistant's points as paragraphs and each of the person's points as a one-line slot, `[Escreva aqui: <description>]`. Typing in a slot completes that point; deleting it puts the point back to "to do". Removing the assistant's text keeps slots the person wrote in. Points the person handles without a slot can be marked done from their opened line.
- **Reminder at Enviar (open issue 9, done).** While `[placeholders]` or untouched slots remain, hovering or focusing Gmail's Enviar shows "O texto ainda tem N espaços por preencher entre [ ]." It never blocks sending.
- **Wording.** "Ou escreva a sua resposta, como sempre."; "A escrever a resposta… pode demorar cerca de um minuto."; the badge and counter count points not yet done.
- **Sources per point (REDESIGN_PLAN E5, done).** A point's opened line shows "Com base em uma resposta anterior:" with the matched past question, the staff's verbatim excerpt and its date when available (from `source_ids` / `source_details`, `BACKEND_SPEC.md` §4). An assistant point with no source says "Não encontrei uma resposta anterior sobre isto."
