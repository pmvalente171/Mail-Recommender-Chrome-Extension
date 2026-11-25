# Redesign plan after the heuristic evaluation (draft)

Status: **agreed** (decisions below). **Built:** E1, E2, E3, E7, the Enviar reminder, E5 and E4 (2026-10-16, see `HANDOFF.md` 14.3); backend B1–B4, B6, B7 live (v0.4). **Next:** E6 (plain wording and expectations). When agreed, contract changes go into `docs/BACKEND_SPEC.md` and UI changes into `docs/handoff/HANDOFF.md` section 14.

## Findings (Pedro's evaluation)

| # | Finding | Heuristics | Severity |
|---|---|---|---|
| 1 | The complexity of the interface does not match the requirements of the task. | 8 aesthetic and minimalist design, 7 flexibility and efficiency | **4** |
| 2 | The steps are bloated and weird; some don't make sense. | 8, 2 match with the real world | **4** |
| 3 | It might be really weird to people who haven't used AI. | 2, 10 help and documentation | **4** |
| 4 | It's weird going back and forth between the AI and the ticket. | 6 recognition rather than recall, 1 system status | 3 |
| 5 | Sometimes the generated steps have incorrect information. | 5 error prevention, 9 recover from errors | severe, but limited by the current knowledge base |

Users are DALM staff who rarely use AI and want to get the job done. **Every change below should remove decisions or controls, not add them.**

## Extension (owner: extension session)

**E1. Compact list (findings 1, 2, 3).** One line per point: status icon, short title, small owner icon. Description, owner toggle and details open only when the row is clicked. The ↳ line appears only when the point needs something from the person.

**E2. Missing information in one place (findings 1, 2).** Instead of fields under each point, a single "Falta saber" block at the top of the list with every missing value, filled once.

**E3. One obvious next step (findings 1, 3).** The footer has one primary button, "Escrever a resposta" (no confirmation step, decision 3). Secondary actions (another version, remove the assistant's text, edit the list) move into a small "Mais" menu.

**E4. Linked colours between the plan and the email (finding 4).** Each point gets a muted colour dot in the panel; its section of the email gets a thin bar of the same colour in the margin. Everything is drawn in a transparent layer on top of the email (as LanguageTool and Grammarly draw underlines), so the email itself never changes. Hovering a point outlines its section; hovering a section highlights its point; clicking a point scrolls to its section. A point with no section yet has no bar, so gaps are visible. Colours stay muted and only stand out on hover. Works for sections the extension placed (the assistant's paragraphs and E7's slots), not for text the person types elsewhere. Inline review controls inside the email stay deferred.

**E7. Slots for the person's own points (findings 1, 4).** "Escrever a resposta" lays out the whole email in plan order: the assistant's points as paragraphs, and each of the person's points as a one-line slot at its position, e.g. `[Escreva aqui: lamentar que a informação ainda não esteja no nosso site]`. Empty slots get a dashed outline (E4). When the person types in a slot, the point counts as done by them automatically. This replaces the "Feito" button: typing is their own action, so only the person completes points. Deleting a slot puts the point back to "to do"; "Retirar texto do assistente" also removes empty slots. A slot left untouched would be sent as text, like the `[N.º de vagas]` placeholders, so E7 ships with **open issue 9**: a non-blocking reminder at Enviar while slots or placeholders remain.

**E5. Show where a point came from (finding 5).** In the expanded row, the source(s) behind the point, with date if available, so people can judge it. Depends on B2.

**E6. Plain wording and expectations (finding 3).** Replace tool vocabulary ("pontos", "gerar") with the staff's own ("O que responder", "Escrever por mim"); tell people up front that preparing takes about a minute; make the first-use guide point at the real interface instead of a block of text.

## Backend (owner: backend session) — reviewed, all feasible

**Key finding.** The live index (`dalm-qa-kb`) is an old, small build: 825 Q&A pairs from May. A June build with **7,809 pairs from 19,932 tickets (Jan 2025 – Jun 2026)** exists but was never indexed. Indexing it gives about 9× the coverage and makes source dates possible. It would replace an index on the shared novasearch cluster and would be keyword search only (BM25) until the embedding model there is redeployed. This probably does more for finding 5 than any prompt change. **Needs Pedro's decision.**

What the index holds today: question, answer, verbatim staff excerpts, reasoning and tags. **No dates or ticket ids** (both recoverable on reindex). The tags already mark time-sensitive answers: `TEMPORAL_ACADEMIC_YEAR`, `TEMPORAL_PERIOD`, `TEMPORAL_SOFT`, `REG_AMOUNT` (fees), `REG_EDITAL`, and others.

**B1. Fewer, plainer points (finding 2). Easy.** At most 4 points (enforced, with a retry), title length checked; ~12-word descriptions and merging of overlapping points are prompted (best-effort).

**B2. Point-level grounding (findings 4, 5). Easy now; dates after reindex.** Additive, backward-compatible contract:
```json
"points": [ { "...": "...", "source_ids": ["s1", "s3"] } ],
"source_details": [
  { "id": "s1", "question": "Onde encontro a informação para pagar a taxa de aceitação?",
    "excerpt": "<verbatim staff snippet, ≤200 chars>", "date": "2025-07-14" }
],
"sources": ["…unchanged, same order, ≤3…"]
```
`source_ids: []` means nothing supports the point. `date` is `null` until reindex. The excerpt is the staff's real text, not a paraphrase. Ticket ids are left out by default, because they point at a real student's ticket.

**B3. Be conservative with claims (finding 5). Easy–medium.**
- (a) Never assert from past answers that something does **not** exist or apply; make it a need.
- (b) Deadlines, years and amounts from answers tagged `TEMPORAL_*`, `REG_AMOUNT` or `REG_EDITAL` become needs unless clearly current. This works with today's index.
- (c) After reindex, answers older than N months count as unconfirmed.

**B4. Need labels as fill-in questions (finding 2). Trivial.** E.g. "N.º de vagas em 2026/27".

**B5. Latency (finding 3).** Output length dominates (Gemma at ~15 tokens/s). B1 roughly halves the list output. Merging the first model call into the main one saves ~10–20 s, but spam then costs a full call. The estimate is **35–50 s** instead of 75–95 s, not yet measured. Under ~20 s needs a faster endpoint (a question for the novasearch admins). Rejected: streaming or partial results (more UI states). Possible but not recommended: a short-lived in-memory cache for reopened replies, which brushes against rule 4.

**B6. Cap on needs (added by the backend, agreed by the extension).** B3 creates more needs, and E2 turns them into fields. At most ~4 needs per list; if more are uncertain, the point goes to the person ("confirm this point") instead of showing five blanks.

**B7. Regression set (added by the backend).** 10–15 redacted threads (Licenciatura, fee/certificate, spam, …) with expected point counts, owners and must-be-needs, run against /list in `agent/eval`. It checks B1/B3 without Gmail. Expected result for the Licenciatura email: 1–2 points with needs for places and conditions, not "the course doesn't exist".

**Backend order:** B1 + B4 (prompt-only, today) → B3 tag rules → B2 without dates → reindex (Pedro) → B5 call restructure, measured before and after.

## Decisions (Pedro, 2026-10-16)

1. **Reindex: not now.** The goal is a stable version first; keep it in the backlog. Until then, sources have no dates.
2. **Too old = more than 24 months** (B3c). Inactive until a reindex adds dates.
3. **No confirmation step.** The assistant's paragraphs no longer wait for "Confirmar"; once written they count as written, and the person reviews them in the email as they would any draft. This changes rule 3 (see below). Whether the person reviewed is measured instead by the edit distance at send (`reply_sent`).
4. **Order of the extension work:** E1–E3 + E7 together (one redesign of the panel and of what gets written) → E4 → E6; E5 after B2.
5. **Defaults accepted:** no ticket ids in the UI, no /list cache, needs capped at ~4, build the regression set.

`BACKEND_SPEC.md` was updated for B1–B4 and B6 (see its revision history).

**Consequence for E3 and E7:** with no confirmation, the main button is just "Escrever a resposta", and the person's own points are completed by typing in their slot (E7), so no tick buttons remain. Points the person handles without a slot (they deleted it or wrote elsewhere) can still be marked done from the expanded row.

## Backlog
- Reindex the June build (7,809 pairs, dates, ticket ids kept server-side).
- Faster model endpoint (novasearch admins) for /list under ~20 s.
- Inline review controls inside the email (deferred from E4).

---

## Round 2: "Falta saber" (2026-10-19)

Status: **agreed** by Pedro (options = grounded candidate values only) and both sessions. `BACKEND_SPEC.md` updated. **Extension built:** F1–F4 (cards, where it goes, options, field type), with fallbacks for backends that only send key and label. **Backend:** implementing the new need fields.

### Findings (Pedro, testing)

1. **It's not clear what the person is filling in.** The label is a long phrase squeezed into a narrow column beside the field ("Nome do serviço ou email para recuperação de password"). There's no link to the step that uses the value or to where it will go in the email.
2. **The assistant should be able to offer options**, so the person picks instead of typing from memory.

Constraint (rule 1): options must come from the sources the backend actually retrieved, never be invented. Offering a value from an old or uncertain past answer as a choice to confirm (with where it came from and its date) fits rule 1 and B3. Stating it in the text as fact does not.

### Extension (owner: extension session)

**F1. One card per missing value, question first.** The question on top in full width, plain language ("Qual é o email para recuperar a password?"), then the field (or options) underneath. No side label column.

**F2. Say where it goes.** Under the question:
- before the reply is written: "Usado no passo ② Recuperação de dados", with the step's colour;
- after it is written: the actual sentence from the email with the blank highlighted, e.g. "…pode pedir novos dados através de **[ ___ ]**." (from the `/generate` segments around the slot).

Focusing or hovering the card outlines that spot in the email (same layer as E4). Clicking "ver no email" scrolls to it.

**F3. Options to pick from.** When the backend found candidate values, they show as choices under the question, each with its source and date if known ("academicos@fct.unl.pt · resposta anterior, jul. 2025"). Clicking one fills the field, and it can still be edited. "Outro" leaves the field free. Leaving it blank stays allowed.

**F4. Right kind of field.** Use the value type for the input: email, date, number, or short text; with a format hint ("ex.: nome@fct.unl.pt").

### Backend (owner: backend session): proposed additive fields on `needs[]`

| Field | Type | Meaning |
|---|---|---|
| `question` | string | The need as a plain pt-PT question, shown as the card's heading ("Qual é o email para recuperar a password?"). |
| `label` | string | **Shorter** than now (≤4 words), used inside the email's brackets: `[Email de recuperação]`. |
| `type` | `"text"` \| `"email"` \| `"date"` \| `"number"` \| `"url"` | Input type; default `"text"`. |
| `hint` | string, optional | Format example: "ex.: nome@fct.unl.pt". Never a real value. |
| `options` | array, optional | Candidate values **found in the retrieved sources** but not confirmed: `[{ "value": "…", "source_id": "s1" }]`, at most 3, deduplicated. Empty when nothing was found. Never invented. |

Everything is additive; current clients keep working.

### Backend review (2026-10-19)

**`question`, short `label`, `type` and `hint` are cheap and fix finding 1. Options are feasible and safe, but on today's index they will almost always be empty.**

Measured on the regression set (v0.4): of 18 needs, 13 have no supporting source at all. Only 1 has a plausible option ("7 dias" for a payment deadline); the other 2 candidates were mismatches. This is structural: a need exists because the sources lacked the fact. Options mostly appear when a value was found but is time-sensitive (B3), which is rare with 825 indexed pairs. The June reindex (backlog) is what would make them common.

Agreed details:
- **`question`**: one sentence ending in "?", pt-PT, no redaction labels. It takes over the "answerable without rereading the email" role from `label`.
- **`label`**: ≤4 words (retry if longer; kept rather than chopped in lenient mode).
- **`type`**: model-chosen from the enum, default `"text"`. `"number"` only for counts (vagas, prestações). Amounts stay `"text"`, because staff write "697 €" or "697,00 euros".
- **`hint`**: set **server-side from `type`**, never by the model, so it can't leak a real value: email → "ex.: nome@fct.unl.pt", date → "ex.: 15/09/2026", url → "ex.: https://…", number → "ex.: 25", text → none.
- **`options`**: the model proposes `{ value, source_id }`. The server keeps one only if `value` appears **verbatim** (whitespace/case-normalised) in the excerpt shown for that source in `source_details`, so the person can always see it in context. The value must also match its type (email pattern, http(s) URL, a date as written). `source_id` must be one of the point's own sources. Never personal data, max 3, deduplicated. `value` is display text, filled in as-is: never normalised or parsed (no ISO dates, no added years).
- **`options[].time_sensitive`**: true when the source is tagged `TEMPORAL_*`/`REG_AMOUNT`/`REG_EDITAL`, or the value names an earlier academic year. The UI says "pode estar desatualizado". An option is never preselected, and `/generate` keeps the slot either way.
- **Latency**: about +2–4 s per list at today's speed (question and type add ~20–25 tokens per need, max 4 needs).
- **Source dates** stay `null` until the reindex, so F3 shows no date (or "data desconhecida").

Final need shape (additive):
```json
{ "key": "email_recuperacao", "label": "Email de recuperação",
  "question": "Qual é o email para recuperar a password?",
  "type": "email", "hint": "ex.: nome@fct.unl.pt",
  "options": [ { "value": "academicos@fct.unl.pt", "source_id": "s1", "time_sensitive": false } ] }
```
`hint` omitted for `"text"`; `options` omitted or `[]` when none. The regression set will check: question ends in "?", label ≤4 words, type in enum, every option verbatim in its source excerpt.

**Consequences for the extension:**
- Design the common case as a question plus an empty field (F1, F2, F4). Options (F3) are the rare case and must look fine absent.
- F2's sentence comes from the `/generate` segments the extension already has; nothing needed from the backend.
- A shared key can belong to two steps, so F2 says "Usado nos passos ② e ③".
- When an option is chosen, highlight it in that source's excerpt in the step's sources panel.

### Open questions

- Pedro: is "options from past answers, with their source" what you meant by "multiple options"? Or also other kinds (e.g. alternative phrasings of a sentence, or yes/no questions the assistant asks)?
- Pedro: agree to the need shape above? Then `BACKEND_SPEC.md` gets updated and the backend implements it (estimated within a day).
