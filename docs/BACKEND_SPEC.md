# Assistente DALM: backend specification

This document specifies the HTTP backend for the **Assistente DALM**, a Chrome extension that adds an optional AI helper to the Gmail reply box of staff in a university's Academic Division (DALM, FCT NOVA). It is written for whoever builds the backend, human or coding agent, and is self-contained: you do not need the extension's repository to implement it.

The extension is finished up to the point of calling these endpoints. It currently answers from a built-in mock. Your backend replaces that mock, so the request and response shapes below are **exactly what the extension sends and parses today** (for `/list`) or what it will parse next (for `/generate`, `/config`, `/log`). Do not rename fields.

The existing backend (`agent/server.py` + `DALMRecommender`, a multi-step LLM and retrieval pipeline that answers in European Portuguese, served on `http://localhost:4000` with `POST /recommend`) is the starting point. Reuse its retrieval, sources and model access. `POST /recommend` is no longer called by the extension and can stay or go.

---

## 1. What the product does

The extension is a **research probe** for a study on how AI can help staff without taking away their freedom not to use it. The flow in Gmail:

1. Staff open an email thread and start a reply. A bar offers help. Nothing is read until they click **Preparar a lista**.
2. The extension reads the thread, removes personal data in the browser, and calls **`POST /list`**. The backend answers with:
   - a one-sentence restatement of what the email asks;
   - the **points** the reply must cover, each with the information the backend could **not** find (`needs`) and a suggestion of **who should handle it** (the assistant or the person);
   - tasks the person must do **outside the email** (in other systems or with other people).
3. For each point the person decides who handles it. They type any missing values into the panel. These values **never leave the browser**.
4. Clicking **Gerar os pontos do assistente** calls **`POST /generate`** with only the points assigned to the assistant. The backend returns one paragraph per point, as text with named **slots** where the missing values go. The extension fills the slots locally and inserts the text into the reply.
5. The person reads the text, edits it, confirms each point, and sends the email themselves.

Everything is in **European Portuguese** (pt-PT).

---

## 2. Rules the backend must respect

These come from the study design and are not negotiable.

1. **Never invent facts.** Numbers of places, grades, dates, deadlines, fees, names of offices or people, rules: if a fact is not in a source you actually retrieved, do not write it. Put it in `needs` (in `/list`) and as a **slot** (in `/generate`). A blank the person fills is correct behaviour; a plausible guess is a failure.
2. **Say what you used.** `/list` returns the names of the sources actually used (`sources`). Never list a source you did not use.
3. **The AI does not act or decide.** It never certifies, graduates or confirms that a student completed something, and it never claims to have done anything in CLIP, SinGAP, Gesdoc or any other system. Points that involve such judgements are suggested as the **person's** (`"owner": "user"`), and actions in those systems go in `outside`.
4. **Personal data.** The thread arrives already redacted (section 3). Do not try to recover redacted values. Do not store thread text beyond the request, and do not log it, unless a participant has explicitly consented to text logging (`/config`, section 6).
5. **Keys stay server-side.** The model API key lives in the backend only. The model must be EU-hosted or one the university has agreed to.
6. **Language and register.** pt-PT (not pt-BR: "você", "registo", "contacto", "equipa", "facto"), formal and courteous, as a university academic office writes.

---

## 3. What the extension sends: the redacted thread

`thread` is plain text built from the **expanded** messages of the Gmail conversation, oldest first, in this format:

```
De: [nome] <[email]>
Data: 13/10/2026, 10:42

Exmos. Srs.,
...message body...

---

De: [nome] <[email]>
Data: 14/10/2026, 09:05

...next message...
```

Messages are separated by a line with `---`. Messages Gmail shows collapsed are not included. Gmail's hidden quoted history ("…") is not included either.

Before sending, the browser replaces personal data with these **labels**:

| Label | Replaces |
|---|---|
| `[email]` | Email addresses |
| `[IBAN]` | IBANs (e.g. `PT50 0002 …`) |
| `[NIB]` | 21-digit Portuguese NIBs |
| `[telefone]` | Phone numbers (+351 or 9 digits starting with 2 or 9) |
| `[NIF]` | Other 9-digit numbers (tax numbers) |
| `[n.º de aluno]` | Standalone 5–6 digit numbers (student numbers, and sometimes other numbers) |
| `[nome]` | The senders' names as Gmail shows them, and each part of those names |

Known gaps: other people's names in the text, and names spelled differently in signatures, are **not** removed. Postal codes, years and course codes are left as they are.

How to treat the labels:
- Treat them as opaque: "the sender's student number", "an email address".
- **Never write a label into a reply.** If the answer needs one of these values (for example to quote the student's number back), make it a `need` and a slot, so the person types it.
- Do not address the sender by name. The greeting is added by the extension (section 5.4).

---

## 4. `POST /list`

Called when the person clicks **Preparar a lista** (or automatically when a reply opens, if they turned on "Preparar sempre").

### Request

```json
{
  "thread": "De: [nome] <[email]>\nData: …\n\nExmos. Srs., …",
  "ticket": "3f1c…64 hex chars…",
  "participant": "p07"
}
```

| Field | Type | Notes |
|---|---|---|
| `thread` | string | Redacted thread, section 3. Can be several thousand characters. |
| `ticket` | string | SHA-256 (hex) of Gmail's thread ID. Stable per conversation, so use it to correlate requests. It is not reversible to the thread. |
| `participant` | string, optional | Pseudonymous study ID. **Not sent yet**: the extension will add it in a later step. Accept its absence. |

### Response (200)

```json
{
  "in_scope": true,
  "request_summary": "um encarregado de educação quer saber se a Licenciatura em Análise e Engenharia de Dados abre vagas em 2026/27 e quais as condições de acesso.",
  "points": [
    {
      "id": "c2",
      "title": "Vagas",
      "desc": "dizer quantas vagas há no concurso de 2026/27.",
      "needs": [ { "key": "vagas", "label": "N.º de vagas" } ],
      "owner": "ai"
    },
    {
      "id": "c3",
      "title": "Condições de acesso",
      "desc": "indicar as provas de ingresso e a nota mínima.",
      "needs": [
        { "key": "provas", "label": "Provas de ingresso" },
        { "key": "nota", "label": "Nota mínima" }
      ],
      "owner": "ai"
    },
    {
      "id": "c5",
      "title": "Site",
      "desc": "lamentar que a informação ainda não esteja no nosso site.",
      "needs": [],
      "owner": "user"
    }
  ],
  "outside": [
    { "id": "o1", "text": "Pedir à equipa do site que publique a página do curso." }
  ],
  "steps": ["Li o email", "Percebi o pedido", "Procurei a informação nas fontes a que tenho acesso"],
  "sources": ["Regulamento de Acesso 2026/27", "Página da DGES do curso"]
}
```

| Field | Type | Rules |
|---|---|---|
| `in_scope` | boolean | `false` if the email is not something the Academic Division answers (spam, personal, another service). Then return `points: []` and `outside: []`, and use `request_summary` to say briefly what the email is. The extension does not show a special message for this yet. It shows the summary and an empty list. |
| `request_summary` | string | **One sentence**, starting in lowercase, completing "O pedido: …". Describe who asks what, without personal data. Shown verbatim. |
| `points` | array | What the reply must cover, in the order the reply should follow. Usually 2–6. Do not include greeting, thanks or sign-off. |
| `points[].id` | string | Unique within the list. Short, e.g. `c1`, `c2`. Sent back to `/generate`. |
| `points[].title` | string | 1–3 words, capitalised: "Vagas", "Condições de acesso". Shown in bold before the description. |
| `points[].desc` | string | Starts in lowercase with an infinitive verb and ends with a full stop: "dizer quantas vagas…", "indicar…", "explicar…", "lamentar…". Shown as "**Title**: desc". |
| `points[].needs` | array | Facts the reply needs that you **could not find in your sources**. Empty if you found everything or the point needs no facts. |
| `needs[].key` | string | **Must match `^[a-z0-9_]+$`** (it is used as an HTML id). Keys are **global to the list**: if two points need the same fact, use the same key and the person types it once. Different facts need different keys. |
| `needs[].label` | string | Short label in pt-PT, capitalised, shown next to the input: "N.º de vagas", "Datas da 1.ª fase". |
| `points[].owner` | `"ai"` or `"user"` | Your **suggestion** of who handles the point. The person can switch it. If missing or anything else, the extension treats it as `"user"`. See the guidelines below. |
| `outside` | array | Tasks the person must do **outside the email**: in CLIP, SinGAP, Gesdoc, or by asking a colleague or service. Each `{ "id": "o1", "text": "…" }`, `text` an imperative sentence in pt-PT. Never things the AI can do. Can be empty. |
| `steps` | array of strings | What you did, past tense, first person, pt-PT. Shown under "Ver passos". The extension adds the line "Não encontrei N informações" itself, so do not include it. |
| `sources` | array of strings | Human-readable names of the sources actually used (documents, pages, regulations). Shown as "Fontes: …". Empty if none. |

**Guidelines for `owner`:**
- `"ai"` for **recurring, factual** points answered from documents: dates, places, requirements, procedures, where to apply, which form to use. This is what staff most want help with.
- `"user"` for points that need **judgement, personal tone or accountability**: apologies, exceptions, anything about a specific student's situation or record, decisions, complaints. Also **always** `"user"` for certifying, confirming completion, graduation, or checking whether someone did something. Staff explicitly refused to hand these to AI.
- When in doubt, `"user"`. The study is about freedom of choice, so the person opting in is better than the AI over-reaching.

---

## 5. `POST /generate`

Called when the person clicks **Gerar os pontos do assistente (N)** or **Gerar outra versão**. The extension wiring for this is the next build step, so implement exactly this contract.

### Request

```json
{
  "thread": "…same redacted thread as /list…",
  "ticket": "3f1c…",
  "participant": "p07",
  "request_summary": "um encarregado de educação quer saber se …",
  "points": [
    { "id": "c2", "title": "Vagas", "desc": "dizer quantas vagas há no concurso de 2026/27.",
      "needs": [ { "key": "vagas", "label": "N.º de vagas" } ] },
    { "id": "c3", "title": "Condições de acesso", "desc": "indicar as provas de ingresso e a nota mínima.",
      "needs": [ { "key": "provas", "label": "Provas de ingresso" }, { "key": "nota", "label": "Nota mínima" } ] }
  ],
  "context_points": [
    { "id": "c5", "title": "Site", "desc": "lamentar que a informação ainda não esteja no nosso site." }
  ],
  "previous": null,
  "instruction": null
}
```

| Field | Type | Notes |
|---|---|---|
| `thread`, `ticket`, `participant` | | As in `/list`. |
| `request_summary` | string | From `/list`. |
| `points` | array | **Only** the points to write now: assigned to the assistant, not yet written, not done. The person may have **edited** titles and descriptions, or **added** points (ids like `n1718…`, often with empty `needs`). Follow the text as given, not your original list. |
| `context_points` | array | The other points of the reply (written by the person). **Do not write them.** Use them only to avoid repeating or contradicting what the person covers. |
| `previous` | array or null | For **Gerar outra versão**: the paragraphs you returned last time for these points, in the response format below. Write a **different** wording, with the same facts and the same slots. `null` on a first generation. |
| `instruction` | string or null | Reserved for a future "Não é isto?" correction. Currently always `null`. If present, follow it. |

The values the person typed for the needs are **never sent**. You will not know them, so write around slots.

### Response (200)

```json
{
  "paragraphs": [
    { "point": "c2", "segments": [
      { "text": "No Concurso Nacional de Acesso 2026/27, o curso tem " },
      { "slot": "vagas" },
      { "text": " vagas." }
    ] },
    { "point": "c3", "segments": [
      { "text": "As provas de ingresso são " },
      { "slot": "provas" },
      { "text": " e a nota mínima de candidatura é de " },
      { "slot": "nota" },
      { "text": " valores." }
    ] }
  ]
}
```

| Rule | |
|---|---|
| One paragraph per requested point | Same order as `points`, `point` = the point's `id`. Never a paragraph for a `context_points` id. |
| `segments` | A list of `{ "text": "…" }` and `{ "slot": "key" }`. Concatenated, they form one paragraph of plain text. |
| Plain text only | No HTML, no Markdown, no bullet characters, no line breaks inside a paragraph. |
| Slots | `slot` must be one of **that point's** `needs[].key`. Every need of the point should appear as a slot exactly where its value belongs, written so the sentence reads correctly once the value is filled in. Never put a redaction label (`[nome]` …) or a made-up value in a `text` segment. |
| No greeting or sign-off | The extension adds "Caro(a) …", the thanks line and the signature from a per-user template. Do not write them. |
| Facts | Only from sources (rule 1). If a fact is missing and is not one of the point's needs, either write the paragraph without it or say plainly that the information will follow ("Enviaremos essa informação logo que esteja disponível."). Never guess. |
| Length | 1–3 sentences per point. The reply is meant to be read and edited. |

The extension inserts the slots as bracketed placeholders, e.g. `[N.º de vagas]`, when the person has not typed a value, and replaces them locally when they do.

---

## 6. `GET /config`

```
GET /config?participant=p07
```

```json
{ "phase": 2, "generate_enabled": true, "text_logging_consent": false }
```

| Field | Notes |
|---|---|
| `phase` | Study phase. Example design: phase 1 = list only, phase 2 = full assistant. Final design is set by the researcher. |
| `generate_enabled` | If `false`, the extension hides all generation buttons (list-only phase). |
| `text_logging_consent` | Whether this participant consented to text being logged. Default `false`. |

Keep the participant-to-phase mapping in a config file the researcher can edit without code changes. Unknown or missing participant: return phase 2 with `generate_enabled: true` and `text_logging_consent: false`.

---

## 7. `POST /log`

The extension queues study events and sends them in batches. Store them append-only (JSONL file or a table) and return `204`.

```json
{
  "events": [
    { "event": "list_requested", "participant": "p07", "ticket": "3f1c…", "phase": 2, "ts": "2026-10-14T15:02:11.204Z" },
    { "event": "owner_changed", "participant": "p07", "ticket": "3f1c…", "phase": 2, "ts": "…", "point": "c4", "to": "user", "suggested": "ai" }
  ]
}
```

Every event has `event`, `participant`, `ticket`, `phase`, `ts` (ISO 8601). Extra fields per event:

| Event | Extra fields |
|---|---|
| `bar_shown`, `list_requested`, `assistant_declined`, `panel_hidden`, `assistant_reopened`, `steps_expanded`, `guide_opened`, `regenerate_clicked` | none |
| `list_shown` | `n_points`, `n_needs` |
| `owner_changed` | `point`, `to` (`"ai"`/`"user"`), `suggested` |
| `point_done`, `point_undone` | `point`, `ai` (bool: written by the assistant), `seconds_since_generated` |
| `value_entered` | `key` (**never the value**) |
| `generate_clicked` | `points` (ids), `n_done_before` |
| `ai_text_removed` | `points` |
| `list_edited` | `added`, `deleted`, `renamed` (counts) |
| `pref_prepare_always` | `value` |
| `reply_sent` | `edit_distance_per_point` (object id → number), `placeholders_left` |

Accept unknown event names and fields (store them as they are). Events contain **metadata only**: reject or strip any field named `text`, `thread`, `value` or `body` unless the participant has `text_logging_consent`.

---

## 8. Errors, timing and transport

- **Calls come from the extension's service worker**, not from the Gmail page. The extension will declare the backend URL in its `host_permissions`, so CORS is not enforced. Allowing it does no harm.
- **Errors:** any non-2xx response makes the extension show "Não foi possível contactar o assistente." with a retry button. Return a JSON body `{ "error": "…" }` with a useful message for the logs. Use `400` for malformed requests (e.g. a `/generate` point id with a slot key not in its needs), `500` for failures.
- **Timing:** the extension animates progress steps while it waits and gives up after **150 s**, so the server's own timeout (currently 120 s) fires first and returns a proper error. Current latency with the shared Gemma endpoint is 30–95 s per call. `/list` blocks the first view of the panel, so it benefits most from being faster (e.g. retrieval plus a single model call).
- **Validate your own output** before returning it: required fields present, need keys match `^[a-z0-9_]+$`, every slot is a need of its point, no paragraph for an unrequested point, no redaction labels in `text`. If the model's output fails, retry once, then return `500`.
- **Base URL:** `http://localhost:4000` during development. In production it will be university-hosted over HTTPS, and the URL is a constant in the extension.

---

## 9. How to test against the extension

1. Run the backend on `http://localhost:4000`.
2. In the extension repo, `public/ServiceWorker.js`: set `MOCK_BACKEND = false`. Add `"host_permissions": ["http://localhost:4000/*"]` to `public/manifest.json`. Run `npm run build` and reload the extension in `chrome://extensions`.
3. Open a thread in Gmail, start a reply, click **Preparar a lista**. To see exactly what the backend received, open `chrome://extensions` → the extension's **service worker** console.

Quick checks with curl:

```bash
curl -s localhost:4000/list -H 'Content-Type: application/json' -d '{
  "thread": "De: [nome] <[email]>\nData: 13/10/2026\n\nExmos. Srs., pretendo saber se a Licenciatura em Análise e Engenharia de Dados abre vagas em 2026/27 e quais as condições de acesso. Não encontro a informação no vosso site. Cumprimentos, [nome]",
  "ticket": "test"
}'

curl -s localhost:4000/generate -H 'Content-Type: application/json' -d '{
  "thread": "…", "ticket": "test", "request_summary": "…",
  "points": [ { "id": "c2", "title": "Vagas", "desc": "dizer quantas vagas há no concurso de 2026/27.", "needs": [ { "key": "vagas", "label": "N.º de vagas" } ] } ],
  "context_points": [], "previous": null, "instruction": null
}'
```

### Acceptance checklist

- [ ] `/list` returns every field in section 4, in pt-PT, with need keys matching `^[a-z0-9_]+$` and unique per fact across the list.
- [ ] Facts not found in sources appear as `needs`, never as invented values. Try an email about a course or year with no documents.
- [ ] Points about certifying, completion or a student's record are suggested as `"owner": "user"`. Actions in CLIP, SinGAP or Gesdoc are in `outside`.
- [ ] An off-topic email returns `in_scope: false` with empty `points` and `outside`.
- [ ] `/generate` returns one paragraph per requested point, in order, plain text, slots only from that point's needs, no greeting or sign-off, no redaction labels.
- [ ] `/generate` with `previous` returns different wording with the same slots.
- [ ] Edited and added points are written as edited. `context_points` are not written.
- [ ] Thread text is not written to logs or disk. `/log` stores metadata only.
- [ ] The model API key is only on the server.
