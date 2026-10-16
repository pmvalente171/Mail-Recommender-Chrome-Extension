# Redesign plan after the heuristic evaluation (draft)

Status: **agreed** (decisions below). **Built:** E1, E2, E3, E7, the Enviar reminder and E5 (2026-10-16, see `HANDOFF.md` 14.3); backend B1–B4, B6, B7 live (v0.3). **Next:** E4, then E6. When agreed, contract changes go into `docs/BACKEND_SPEC.md` and UI changes into `docs/handoff/HANDOFF.md` section 14.

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
