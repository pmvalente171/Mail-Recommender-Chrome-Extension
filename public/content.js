// Content script: adds the "Assistente DALM" to Gmail's inline reply box.
// The spec and the clickable prototype are in docs/handoff/. Everything the
// assistant draws lives in a shadow root *outside* the reply's editable body,
// so nothing it renders can become part of the email.

// --- Gmail thread and reply box ---------------------------------------------
// Gmail class names (.a3s message body, .gD sender, .g3 date, h2.hP subject)
// are obfuscated but have been stable for years. If Gmail changes them, these
// are the selectors to update.

// The open conversation that contains this reply box, or null if the box is
// not an inline reply in a thread (e.g. a new message from "Compor").
function findThreadView(replyBox) {
  const main = replyBox.closest('[role="main"]')
  if (!main) return null
  const hasMessages = [...main.querySelectorAll('.a3s')].some((body) => !replyBox.contains(body))
  return hasMessages ? main : null
}

function getThreadId(threadView) {
  const subject = threadView.querySelector('h2[data-thread-perm-id], h2[data-legacy-thread-id]')
  if (subject) return subject.dataset.threadPermId || subject.dataset.legacyThreadId
  // Fallback: the last segment of the URL, e.g. #label/DALM+Examples/KtbxLz…
  return location.hash.split('/').pop() || ''
}

// Reads the text of the open thread. Only call this after an explicit click:
// nothing in the email is read until the person asks for it.
// Only expanded messages are read; Gmail does not render the bodies of
// collapsed messages, so earlier messages hidden behind a count are skipped.
function readThread(replyBox) {
  const threadView = findThreadView(replyBox)
  if (!threadView) return null

  const subjectEl = threadView.querySelector('h2.hP')
  const messages = [...threadView.querySelectorAll('.a3s')]
    .filter((body) => !replyBox.contains(body))
    .map((body) => {
      const container = body.closest('.adn') || body.parentElement
      const sender = container.querySelector('.gD')
      const date = container.querySelector('.g3')
      return {
        from: sender ? sender.getAttribute('name') || sender.textContent.trim() : '',
        email: sender ? sender.getAttribute('email') || '' : '',
        date: date ? date.getAttribute('title') || date.textContent.trim() : '',
        // innerText keeps line breaks and skips Gmail's hidden "..." trimmed
        // quote, which only repeats earlier messages.
        text: body.innerText.trim()
      }
    })
    .filter((message) => message.text)

  const text = messages
    .map((m) => `De: ${m.from}${m.email ? ` <${m.email}>` : ''}\nData: ${m.date}\n\n${m.text}`)
    .join('\n\n---\n\n')

  return {
    threadId: getThreadId(threadView),
    subject: subjectEl ? subjectEl.textContent.trim() : '',
    messages,
    text
  }
}

// --- Personal data ----------------------------------------------------------
// Removed in the browser before anything leaves it (HANDOFF.md rule 7). The
// patterns are deliberately broad: a false positive costs the model a little
// context, a miss sends personal data. Order matters (IBAN and NIB before the
// shorter number patterns).
// Known limitation: names are only caught when they match a sender's name as
// Gmail shows it (full name, or any part of it). Other people mentioned in the
// text, or signatures that spell a name differently, are not removed.
const REDACTIONS = [
  ['[email]', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['[IBAN]', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g],
  ['[NIB]', /\b\d{4}[ .]?\d{4}[ .]?\d{11}[ .]?\d{2}\b/g],
  ['[telefone]', /(?:\+|00) ?351[ .-]?\d{3}[ .-]?\d{3}[ .-]?\d{3}\b|\b[29]\d{2}[ .-]?\d{3}[ .-]?\d{3}\b/g],
  ['[NIF]', /\b\d{9}\b/g],
  ['[n.º de aluno]', /\b\d{5,6}\b/g]
]

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function redact(text, names) {
  let out = text
  for (const [label, pattern] of REDACTIONS) out = out.replace(pattern, label)
  // Full names first, then their parts (3+ letters), longest first.
  const parts = names.flatMap((n) => [n, ...n.split(/\s+/)])
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length)
  for (const name of new Set(parts)) {
    out = out.replace(new RegExp(`(?<!\\p{L})${escapeRegExp(name)}(?!\\p{L})`, 'gu'), '[nome]')
  }
  return out
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// --- Backend (through the service worker) -----------------------------------
// When the extension is reloaded or updated, the copy of this script already
// running in an open Gmail tab is cut off from it: chrome.runtime goes away
// and any extension call throws. Check before calling, and stop quietly.
function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id) } catch (e) { return false }
}

async function callBackend(type, payload) {
  if (!extensionAlive()) throw new Error('Extension reloaded')
  const response = await chrome.runtime.sendMessage({ type, payload })
  if (!response || !response.ok) throw new Error(response ? response.error : 'No response')
  return response.data
}

// Returns the list plus what /generate needs later: the redacted thread and
// ticket that were sent, and the requester's name for the greeting, which
// stays in the browser.
async function requestList(replyBox) {
  if (!extensionAlive()) throw new Error('Extension reloaded')
  const thread = readThread(replyBox)
  if (!thread || !thread.text) throw new Error('No thread text')
  const names = thread.messages.map((m) => m.from).filter(Boolean)
  const sent = { thread: redact(thread.text, names), ticket: await sha256(thread.threadId) }
  const list = await callBackend('dalm:list', sent)
  return { list, sent, requester: names[0] || '' }
}

async function requestGenerate(payload) {
  const data = await callBackend('dalm:generate', payload)
  return (data && data.paragraphs) || []
}

// Fixed text around the assistant's paragraphs, added locally when the reply
// is empty (HANDOFF.md section 4: greeting, thanks and sign-off come from a
// template, not the model).
const TEMPLATE = {
  greeting: (name) => name ? `Caro(a) ${name},` : 'Caro(a) Senhor(a),',
  thanks: 'Obrigado pelo seu contacto.',
  signoff: ['Com os melhores cumprimentos,', 'Divisão Académica'],
  // The line left in the email for a point the person writes themselves.
  slot: (point) => `[Escreva aqui: ${(point.desc || point.title).replace(/\.\s*$/, '')}]`
}
// Gmail's own signature and quoted text: the assistant's text goes above them.
const GMAIL_TAIL = '.gmail_signature, .gmail_signature_prefix, .gmail_quote, .gmail_extra'

// Fills in defaults so the panel never has to guess at missing fields.
function normalizeList(list) {
  return {
    request: list.request_summary || '',
    // owner: who the backend suggests should handle the point; the person can
    // switch it. Without a suggestion the point is the person's.
    points: (list.points || []).map((p, i) => ({
      id: String(p.id || `p${i}`), title: p.title || '', desc: p.desc || '',
      needs: p.needs || [], owner: p.owner === 'ai' ? 'ai' : 'user',
      sourceIds: (p.source_ids || []).map(String),
      done: false, ai: false, writing: false
    })),
    // The past answers behind the points: the matched question, a verbatim
    // excerpt of the staff's reply, and its date when the index has one.
    sourceDetails: (list.source_details || [])
      .filter((s) => s && s.id && s.excerpt)
      .map((s) => ({ id: String(s.id), question: s.question || '', excerpt: s.excerpt, date: s.date || null })),
    outside: (list.outside || []).map((o, i) => ({ id: String(o.id || `o${i}`), text: o.text || '', done: false })),
    steps: list.steps || [],
    sources: list.sources || []
  }
}

const STEPS_LIST = ['A ler o email', 'A perceber o pedido', 'A procurar a informação nas fontes a que tenho acesso']
const STEP_DELAY_MS = 650

// Short plain messages for failures (HANDOFF.md open issue 8).
function errorMessage(err) {
  if (err && err.message === 'No thread text') return 'Não consegui ler o email desta conversa.'
  if (err && err.message === 'Extension reloaded') return 'A extensão foi atualizada. Recarregue o Gmail para continuar.'
  if (!navigator.onLine) return 'Sem ligação à internet.'
  return 'Não foi possível contactar o assistente.'
}

// --- Preferences ------------------------------------------------------------
// The only settings the spec allows: the first-use guide and "Preparar sempre".
const prefs = { guideSeen: true, prepareAlways: false }
const prefsReady = chrome.storage.sync.get({ guideSeen: false, prepareAlways: false })
  .then((stored) => Object.assign(prefs, stored))
  .catch(() => {})

function savePref(key, value) {
  prefs[key] = value
  if (extensionAlive()) chrome.storage.sync.set({ [key]: value }).catch(() => {})
}

// --- Styles -----------------------------------------------------------------
// Tokens and component styles ported from docs/handoff/prototype.html.
const UI_CSS = `
:host{all:initial;
  --green-900:#173F33; --green-700:#1F5C4A; --green-600:#2F8A63; --green-300:#8FB3A3;
  --green-200:#A9C9BB; --green-100:#EAF3EF; --green-50:#F2F7F4; --panel-line:#E3EBE7; --panel-border:#C9D8D0;
  --ink:#1E2421; --ink-2:#3D4F48; --ink-3:#5F6F68; --ink-4:#80868B;
  --amber-line:#B8921C; --amber-text:#6B4E00; --amber-field:#FFFBEF; --amber-field-line:#E2C76E;
  --danger-line:#E3B4B4; --danger-ink:#8A2C2C;
  --font-ui:'Public Sans DALM','Helvetica Neue',Arial,sans-serif;
  --font-mail:Arial,Helvetica,sans-serif;
  --float-shadow:0 10px 28px rgba(23,40,34,.20),0 2px 6px rgba(23,40,34,.10)}
*{box-sizing:border-box}
.root{font-family:var(--font-ui);color:var(--ink);font-size:14px;line-height:1.4}
button{font-family:inherit;cursor:pointer}
:focus-visible{outline:3px solid #2F6FD0;outline-offset:2px}

.btn-primary{font-size:14.5px;font-weight:600;padding:0 22px;min-height:44px;border-radius:22px;border:0;background:var(--green-700);color:#fff;display:inline-flex;align-items:center;gap:8px}
.btn-secondary{font-size:13.5px;font-weight:600;padding:0 16px;min-height:40px;border-radius:20px;border:1px solid var(--green-300);background:#fff;color:var(--green-700)}
.btn-quiet{font-size:14.5px;font-weight:600;padding:0 16px;min-height:44px;border-radius:22px;border:0;background:transparent;color:var(--ink-2)}
.link{font-size:12.5px;font-weight:600;padding:0 6px;min-height:30px;border:0;background:transparent;color:var(--green-700);text-decoration:underline}
.link.muted{color:var(--ink-2)}

.bar{display:flex;flex-direction:column;gap:10px}
.bar-card{display:flex;align-items:center;gap:12px 14px;flex-wrap:wrap;padding:14px 16px;background:var(--green-50);border:1px solid var(--green-200);border-radius:12px;box-shadow:var(--float-shadow)}
.badge{flex:0 0 auto;width:34px;height:34px;border-radius:50%;background:var(--green-700);color:#fff;display:flex;align-items:center;justify-content:center}
.badge.sm{width:24px;height:24px}
.bar-text{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:2px}
.bar-text strong{font-size:15px;color:var(--green-900)}
.bar-text span{font-size:13.5px;color:var(--ink-2)}
.mail-hint{flex:1 1 100%;font-size:12.5px;color:var(--ink-3)}
.chip-row{display:flex;justify-content:flex-end}
.fab{display:inline-flex;align-items:center;height:32px;padding:0 3px;border-radius:16px;border:1px solid var(--green-200);background:#fff;color:var(--green-700);font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(23,40,34,.18);transition:box-shadow .18s ease}
.fab:hover,.fab:focus-visible{box-shadow:0 4px 14px rgba(23,40,34,.24)}
.fab-icon{flex:0 0 auto;width:24px;height:24px;border-radius:50%;background:var(--green-700);color:#fff;display:flex;align-items:center;justify-content:center}
.fab-label{max-width:0;overflow:hidden;white-space:nowrap;opacity:0;transition:max-width .24s ease,opacity .18s ease,margin .24s ease}
.fab:hover .fab-label,.fab:focus-visible .fab-label{max-width:170px;opacity:1;margin:0 4px 0 8px}
.fab-count{min-width:18px;height:18px;margin:0 2px 0 4px;padding:0 5px;border-radius:9px;background:var(--green-600);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
@keyframes dalm-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
@keyframes dalm-drop{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}
@keyframes dalm-slide-in{from{opacity:0;transform:translateX(32px)}to{opacity:1;transform:none}}
@keyframes dalm-slide-out{to{opacity:0;transform:translateX(32px)}}
@keyframes dalm-fade-out{to{opacity:0;transform:translateY(-6px)}}
.enter .fab{animation:dalm-pop .2s ease-out;transform-origin:right center}
.enter .bar{animation:dalm-drop .22s ease-out;transform-origin:top right}
.enter .panel{animation:dalm-slide-in .26s cubic-bezier(.2,.8,.2,1)}
.leaving .panel{animation:dalm-slide-out .18s ease-in forwards}
.leaving .bar{animation:dalm-fade-out .16s ease-in forwards}

.panel{display:flex;flex-direction:column;background:#fff;border:1px solid var(--panel-border);border-radius:14px;overflow:hidden;height:var(--panel-height,560px);box-shadow:var(--float-shadow)}
.panel-head{display:flex;align-items:center;gap:6px;padding:12px 16px;border-bottom:1px solid var(--panel-line);cursor:grab;user-select:none;touch-action:none}
.panel-head button{cursor:pointer}
.panel.dragging{box-shadow:0 18px 40px rgba(23,40,34,.28),0 4px 10px rgba(23,40,34,.12)}
.panel.dragging .panel-head{cursor:grabbing}
.panel-head strong{flex:1 1 auto;font-size:15px;color:var(--green-900)}
.panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 18px 10px;display:flex;flex-direction:column;gap:14px}
.panel-foot{display:flex;flex-direction:column;gap:10px;padding:12px 18px;border-top:1px solid var(--panel-line);background:#F7FAF8}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.steps{padding:18px;display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:10px;align-items:center;font-size:14.5px}
.step.pending{color:#A3ADA8}
.step-dots{width:18px;text-align:center;color:var(--green-300);font-weight:700}
.summary{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink-3)}
.summary span{flex:1 1 auto}
.steplist{margin:0;padding:0 0 0 23px;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12.5px;color:var(--ink-3)}
.request{margin:0;font-size:14px;line-height:1.5}
.section{display:flex;flex-direction:column;gap:8px}
.section-head{display:flex;align-items:baseline;gap:8px}
.section-head strong{flex:1 1 auto;font-size:14px}
.section-head span{font-size:12.5px;font-weight:600;color:var(--ink-2);white-space:nowrap}
.hint{font-size:12.5px;color:var(--ink-3)}
.legend{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.rows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.row-item{border-radius:10px}
.row-item.open{background:#F6F8F7}
.row-item.hl{background:#F3F6F4;box-shadow:inset 3px 0 0 var(--pc)}
.pnum{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:var(--pc);color:#fff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center}
.pnum.ghost{background:transparent;border:1.5px dashed var(--green-300);color:var(--green-700)}
.row-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.row-sub{font-size:12.5px;line-height:1.35;color:var(--ink-3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row-item.editing .row-head{align-items:flex-start;padding-top:6px;padding-bottom:6px}
.row-item.editing .pnum{margin-top:7px}
.edit-fields{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.edit-title,.edit-desc{width:100%;font:inherit;min-height:34px;padding:0 10px;border:1px solid #C4CDC8;border-radius:8px;background:#fff;color:var(--ink)}
.edit-title{font-size:14px;font-weight:600}
.edit-desc{font-size:13px;color:var(--ink-2)}
.icon-btn{flex:0 0 auto;width:36px;height:36px;padding:0;border:0;border-radius:18px;background:transparent;color:var(--danger-ink);display:flex;align-items:center;justify-content:center}
.icon-btn:hover{background:#FBEFEF}
.icon-btn.add{color:var(--green-700)}
.icon-btn.add:hover{background:var(--green-50)}
.row-head{width:100%;display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 6px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left}
button.row-head:hover{background:#F1F4F2}
.row-head.static{cursor:default}
.row-title{min-width:0;font-size:14px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-title.plain{font-weight:400;white-space:normal}
.row-title.done{color:var(--ink-3)}
.row-owner{flex:0 0 auto;width:26px;height:26px;border-radius:13px;display:flex;align-items:center;justify-content:center;color:var(--ink-3);background:#EEF1EF}
.row-owner.ai{color:var(--green-700);background:var(--green-100)}
.chev{flex:0 0 auto;display:flex;color:var(--ink-4);transition:transform .2s ease}
.row-item.open .chev{transform:rotate(180deg)}
.row-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px 36px}
.row-item.opening .row-body{animation:dalm-drop .18s ease-out}
.row-desc{margin:0;font-size:13.5px;line-height:1.45;color:var(--ink-2)}
.state{flex:0 0 auto;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--ink-4)}
.state .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.state.done{color:var(--green-600)}
.state.ask{color:var(--amber-line)}
.state .ring{width:15px;height:15px;border:2px dashed var(--green-700);border-radius:50%}
.state .spin{width:15px;height:15px;border:2px solid var(--green-200);border-top-color:var(--green-700);border-radius:50%;animation:dalm-spin .8s linear infinite}
@keyframes dalm-spin{to{transform:rotate(360deg)}}
.seg{display:inline-flex;align-self:flex-start;padding:2px;border-radius:18px;border:1px solid var(--panel-border);background:#fff}
.seg button{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border:0;border-radius:16px;background:transparent;color:var(--ink-2);font-size:12.5px;font-weight:600}
.seg button[aria-pressed="true"]{background:var(--green-700);color:#fff}
.seg button:disabled{cursor:default;opacity:.55}
.out{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-3)}
.act{font-size:12.5px;font-weight:600;min-height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--green-300);background:#fff;color:var(--green-700);white-space:nowrap}
.act.primary{background:var(--green-700);border-color:var(--green-700);color:#fff}
.needs{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:#FFF9E8;border:1px solid #F1DE9C}
.btn-more{display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:600;min-height:40px;padding:0 12px;border:0;border-radius:20px;background:transparent;color:var(--ink-2);margin-left:auto}
.btn-more:hover{background:#EEF1EF}
.btn-more[aria-expanded="true"] svg{transform:rotate(180deg)}
.menu{display:flex;flex-direction:column;padding:4px;border:1px solid var(--panel-line);border-radius:10px;background:#fff;box-shadow:0 6px 16px rgba(23,40,34,.12)}
.menu.opening{animation:dalm-drop .16s ease-out}
.menu-item{text-align:left;font-size:13.5px;min-height:36px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--ink)}
.menu-item:hover{background:var(--green-50)}
.srcs{display:flex;flex-direction:column;gap:6px}
.srcs-head,.srcs-none{font-size:12px;font-weight:600;color:var(--ink-3)}
.src{margin:0;display:flex;flex-direction:column;gap:3px}
.src figcaption{font-size:12.5px;font-weight:600;color:var(--ink-2)}
.src blockquote{margin:0;padding:2px 0 2px 10px;border-left:2px solid var(--green-200);font-size:12.5px;line-height:1.45;color:var(--ink-3)}
.send-tip{display:flex;align-items:center;gap:8px;max-width:360px;padding:10px 14px;border-radius:10px;background:#FFF9E8;border:1px solid #F1DE9C;color:var(--amber-text);font-size:13px;font-weight:600;box-shadow:0 6px 16px rgba(23,40,34,.16)}
.enter .send-tip{animation:dalm-drop .16s ease-out}
.field{display:flex;align-items:center;gap:8px}
.field label{flex:0 0 auto;width:118px;font-size:12.5px;color:var(--amber-text)}
.field input{flex:1 1 auto;min-width:0;font:inherit;font-size:13.5px;padding:0 10px;min-height:34px;border:1px solid var(--amber-field-line);border-radius:8px;background:var(--amber-field);color:var(--ink)}
.field input.filled{border-color:#C4CDC8;background:#fff}
.message{font-size:13px;font-weight:600;color:var(--green-700)}
.message.warn{color:var(--amber-text)}
.persist{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--ink-3)}
.persist input{width:15px;height:15px;margin:2px 0 0;accent-color:var(--green-700)}

.guide{background:#fff;border:1px solid var(--green-200);border-radius:16px;box-shadow:0 12px 32px rgba(23,40,34,.22);padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--green-700)}
.guide > strong{font-size:19px;line-height:1.25;color:var(--green-900)}
.guide ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;font-size:14.5px}
.guide li{display:flex;gap:12px;align-items:flex-start}
.num{flex:0 0 auto;width:24px;height:24px;border-radius:50%;background:var(--green-100);color:var(--green-700);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}.state .spin{animation:dalm-spin 3s linear infinite!important}}
`

// Sizes, in px. The badge and the "Quer ajuda?" card sit at the reply's
// top-right corner; the panel docks to the right edge of the window.
const PANEL_WIDTH = 420
const BAR_WIDTH = 440
const PANEL_MIN_HEIGHT = 280
const EDGE = 8 // gap to the reply's corner
const DOCK_GAP = 16 // gap between the docked panel and the window's edges
const LEAVE_MS = 180 // length of the closing animations

// Where the person dragged the panel ({ left, top } in px), or null when it is
// docked to the right edge. Shared by every reply on the page and kept until
// the page reloads; double-clicking the panel's header docks it again.
let panelSpot = null

// Page-level styles: the font, and the floating host. The host lives on
// <body>, not inside Gmail's reply, so it never changes Gmail's layout and no
// Gmail container can clip it.
function injectPageStyles() {
  if (document.getElementById('dalm-page-style')) return
  const style = document.createElement('style')
  style.id = 'dalm-page-style'
  const font = chrome.runtime.getURL('fonts/public-sans-latin-wght-normal.woff2')
  style.textContent = `
    @font-face{font-family:'Public Sans DALM';font-style:normal;font-weight:100 900;font-display:swap;
      src:url(${font}) format('woff2-variations'),url(${font}) format('woff2')}
    [data-dalm-host]{display:block;position:fixed;z-index:990;margin:0}
  `
  document.head.appendChild(style)
}

// Gmail listens for keyboard shortcuts on the page. Key events from inside a
// shadow root are retargeted to the host, so typing "c" in one of our fields
// would open a new message. Stop them (and clicks) at the host.
function isolateEvents(host) {
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown']) {
    host.addEventListener(type, (e) => e.stopPropagation())
  }
}

// --- Rendering helpers ------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const SPARK = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>`
const TICK = (s, color, w) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`

// Inlined from public/icons/*.svg (edit those, then copy the shapes here), so
// they take the panel's colours through currentColor.
const ICON_SHAPES = {
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  question: '<path d="M8.5 8a3.5 3.5 0 1 1 5.25 3.03C12.7 11.63 12 12.4 12 13.6v1.4"/><circle cx="12" cy="19.5" r="1.25" fill="currentColor" stroke="none"/>',
  robot: '<path d="M12 8V5.5"/><circle cx="12" cy="3.5" r="1.5"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M2 12.5v3"/><path d="M22 12.5v3"/><circle cx="9" cy="13" r="1.25" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.25" fill="currentColor" stroke="none"/><path d="M10 16.5h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  remove: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  add: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/>'
}
const ICON = (name, s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_SHAPES[name]}</svg>`

// --- First-use guide (one per page) -----------------------------------------
let guideHost = null

function showGuide() {
  if (guideHost) return
  guideHost = document.createElement('div')
  guideHost.style.cssText = `position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:2147483000;width:min(560px,calc(100vw - 32px))`
  isolateEvents(guideHost)
  const root = guideHost.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${UI_CSS}</style>
    <div class="root guide" role="dialog" aria-label="Como funciona o Assistente DALM"><span class="eyebrow">Assistente DALM · opcional</span>
    <strong>Uma ajuda para não esquecer nada nas respostas</strong><ol>
    <li><span class="num">1</span><span>Clique em <strong>Preparar a lista</strong>. O assistente diz o que percebeu do pedido e o que a resposta deve tratar.</span></li>
    <li><span class="num">2</span><span>Escolha quem trata cada ponto: você ${ICON('user', 15)} ou o assistente ${ICON('robot', 15)}. Se faltar informação, preencha-a ou deixe em branco.</span></li>
    <li><span class="num">3</span><span>Se quiser, clique em <strong>Gerar os pontos do assistente</strong>: ele só escreve os pontos que lhe deu. Leia o texto e confirme cada um. <strong>Nada é enviado sem si.</strong></span></li>
    </ol>
    <label class="persist"><input type="checkbox" ${prefs.prepareAlways ? 'checked' : ''} data-a="toggleAlways">Preparar esta lista sempre que abro uma resposta (fica guardado)</label>
    <div><button class="btn-primary" data-a="closeGuide">Percebi</button></div></div>`
  // "Preparar sempre" lives here rather than in the panel footer, which it
  // crowded (HANDOFF.md open issue 10).
  root.addEventListener('change', (e) => {
    if (e.target.dataset.a === 'toggleAlways') savePref('prepareAlways', e.target.checked)
  })
  root.addEventListener('click', (e) => { if (e.target.closest('[data-a="closeGuide"]')) closeGuide() })
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGuide() })
  document.body.appendChild(guideHost)
  root.querySelector('[data-a="closeGuide"]').focus()
}

function closeGuide() {
  if (!guideHost) return
  guideHost.remove()
  guideHost = null
  savePref('guideSeen', true)
}

// --- The assistant attached to one reply box --------------------------------
function createAssistant(replyBox) {
  const host = document.createElement('div')
  host.dataset.dalmHost = ''
  isolateEvents(host)
  const root = host.attachShadow({ mode: 'open' })
  document.body.appendChild(host)

  let S = {
    view: 'ready', // 'ready' | 'declined' | 'working' | 'list'
    request: '', points: [], outside: [], steps: [], sources: [], values: {},
    editing: false, snapshot: null, newText: '',
    stepTexts: [], stepIdx: 0, stepsOpen: false, hadList: false,
    error: null, retry: null,
    openId: null, // the list row that is expanded
    moreOpen: false // the "Mais" menu
  }
  let timer = null
  let workToken = 0 // bumped on cancel, so a late response is ignored

  function set(patch) {
    S = Object.assign({}, S, typeof patch === 'function' ? patch(S) : patch)
    render()
  }

  const has = (key) => !!(S.values[key] || '').trim()

  // Shows the progress steps one at a time while `work` runs. The last step
  // stays in progress until the work settles; then `after(result)` is applied,
  // or an error with "Tentar outra vez" (which reruns the action `retry`).
  function runWork(texts, work, after, retry) {
    clearTimeout(timer)
    const token = ++workToken
    set({ view: 'working', stepTexts: texts, stepIdx: 0, editing: false, error: null, retry })
    let settled = false
    let animated = false
    let result
    let failure = null
    const finish = () => {
      if (token !== workToken || !settled || !animated) return
      if (failure) set({ error: failure })
      else set(after(result))
    }
    work.then((r) => { result = r }, (e) => { failure = e })
      .finally(() => { settled = true; finish() })
    const tick = (i) => {
      timer = setTimeout(() => {
        if (i >= texts.length) { animated = true; finish(); return }
        set({ stepIdx: i })
        tick(i + 1)
      }, STEP_DELAY_MS)
    }
    tick(1)
  }

  function stopWork() {
    clearTimeout(timer)
    workToken++
  }

  // The conversation scrolls inside a Gmail container, not the page.
  const scroller = (() => {
    for (let n = replyBox.parentElement; n; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n
    }
    return null
  })()

  const panelOpen = () => S.view === 'working' || S.view === 'list'

  // Floats over Gmail like LanguageTool: nothing in Gmail's layout changes, so
  // the person's text never moves. The badge and the "Quer ajuda?" card sit at
  // the reply's top-right corner (sticking to the top of the visible area while
  // the reply scrolls, hidden when it is out of view); the panel docks to the
  // right edge of the window, below Gmail's top bar, and stays put.
  function position() {
    placeHost()
    drawMarks()
  }

  function placeHost() {
    if (!replyBox.isConnected) return
    const clip = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    const viewportWidth = document.documentElement.clientWidth
    if (panelOpen()) {
      const width = Math.max(280, Math.min(PANEL_WIDTH, viewportWidth - 2 * DOCK_GAP))
      const dockTop = Math.max(clip.top, 0) + DOCK_GAP / 2
      let top = dockTop
      host.style.display = ''
      host.style.width = `${width}px`
      if (panelSpot) {
        // Dragged: keep it inside the window, with room for a usable height.
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))
        top = clamp(panelSpot.top, DOCK_GAP / 2, window.innerHeight - PANEL_MIN_HEIGHT - DOCK_GAP)
        host.style.left = `${clamp(panelSpot.left, DOCK_GAP / 2, viewportWidth - width - DOCK_GAP / 2)}px`
        host.style.removeProperty('right')
      } else {
        host.style.removeProperty('left')
        host.style.right = `${DOCK_GAP}px`
      }
      host.style.top = `${top}px`
      host.style.setProperty('--panel-height', `${Math.max(PANEL_MIN_HEIGHT, window.innerHeight - top - DOCK_GAP)}px`)
      return
    }
    host.style.removeProperty('left')
    const r = replyBox.getBoundingClientRect()
    const top = Math.max(r.top, clip.top) + EDGE
    const visible = Math.min(r.bottom, clip.bottom) - top
    if (!r.width || visible < 24) { host.style.display = 'none'; return }
    host.style.display = ''
    host.style.top = `${top}px`
    host.style.right = `${viewportWidth - r.right + EDGE}px`
    host.style.width = S.view === 'ready' ? `${Math.min(BAR_WIDTH, r.width - 2 * EDGE)}px` : 'auto'
  }

  // --- Linked colours between the plan and the email (REDESIGN_PLAN.md E4) ---
  // Each point has a muted colour: a dot in the panel, and a thin bar in the
  // email's margin next to the section the extension placed for it (the
  // assistant's paragraph or the person's slot). Empty slots also get a dashed
  // outline. Everything is drawn in a transparent layer over the email, as
  // LanguageTool draws its underlines, so the email itself never changes.
  // Hovering a point outlines its section; hovering a section highlights its
  // point. Only sections the extension placed are linked.
  const PALETTE = ['#3E8E6E', '#4A74B5', '#B7743A', '#8A5BB0', '#3E8F96', '#A85C7A']
  const colorOf = (id) => {
    const i = S.points.findIndex((p) => p.id === id)
    return PALETTE[Math.max(0, i) % PALETTE.length]
  }
  const tint = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`
  let hoverId = null

  const marks = document.createElement('div')
  marks.dataset.dalmHost = ''
  Object.assign(marks.style, { zIndex: '989', pointerEvents: 'none', overflow: 'hidden', display: 'none' })
  document.body.appendChild(marks)

  function drawMarks() {
    if (!S.hadList || !blocks.size || !replyBox.isConnected || !replyBox.getBoundingClientRect().width) { marks.style.display = 'none'; return }
    // Clip to the visible part of the conversation, so marks never float over
    // Gmail's header when the reply is scrolled.
    const clip = scroller ? scroller.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    Object.assign(marks.style, { display: '', left: `${clip.left}px`, top: `${clip.top}px`, width: `${clip.width}px`, height: `${clip.height}px` })
    let html = ''
    for (const [id, b] of blocks) {
      if (!b.el.isConnected) continue
      const r = b.el.getBoundingClientRect()
      if (!r.height) continue
      const top = r.top - clip.top
      const left = r.left - clip.left
      const c = colorOf(id)
      const hot = hoverId === id
      const empty = b.kind === 'slot' && untouched(b)
      html += `<div style="position:absolute;left:${left - 10}px;top:${top}px;width:3px;height:${r.height}px;border-radius:2px;background:${c};opacity:${hot ? 1 : 0.55}"></div>`
      if (hot || empty) {
        html += `<div style="position:absolute;left:${left - 5}px;top:${top - 2}px;width:${r.width + 10}px;height:${r.height + 4}px;border-radius:6px;border:1.5px ${empty && !hot ? 'dashed' : 'solid'} ${c};background:${hot ? tint(c, 0.08) : 'transparent'};box-sizing:border-box"></div>`
      }
    }
    marks.innerHTML = html
  }

  function setHover(id) {
    if (id === hoverId) return
    hoverId = id
    drawMarks()
    for (const li of root.querySelectorAll('.row-item[data-pid]')) li.classList.toggle('hl', li.dataset.pid === id)
  }

  // Hover from the panel…
  root.addEventListener('mouseover', (e) => {
    const li = e.target.closest('.row-item[data-pid]')
    setHover(li && blocks.has(li.dataset.pid) ? li.dataset.pid : null)
  })
  host.addEventListener('mouseleave', () => setHover(null))
  // …and from the email.
  replyBox.addEventListener('mousemove', (e) => {
    let found = null
    for (const [id, b] of blocks) if (b.el.isConnected && b.el.contains(e.target)) { found = id; break }
    setHover(found)
  })
  replyBox.addEventListener('mouseleave', () => setHover(null))

  // Opening a point brings its section into view if it's out of sight.
  function scrollToSection(id) {
    const b = blocks.get(id)
    if (!b || !b.el.isConnected) return
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    b.el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }

  // Dragging the panel by its header (not by its buttons). Listening on the
  // window keeps the drag going even if the panel re-renders under the pointer.
  root.addEventListener('pointerdown', (e) => {
    const head = e.target.closest('.panel-head')
    if (!head || e.button !== 0 || e.target.closest('button, a, input')) return
    e.preventDefault()
    const start = host.getBoundingClientRect()
    const dx = e.clientX - start.left
    const dy = e.clientY - start.top
    const panel = root.querySelector('.panel')
    if (panel) panel.classList.add('dragging')
    const move = (ev) => { panelSpot = { left: ev.clientX - dx, top: ev.clientY - dy }; position() }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      const p = root.querySelector('.panel')
      if (p) p.classList.remove('dragging')
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
  })
  root.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.panel-head') || e.target.closest('button, a, input')) return
    panelSpot = null
    position()
  })

  // Plays the closing animation, then applies the change.
  function leaveThen(patch) {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const box = root.querySelector('.root')
    if (reduced || !box) { set(patch); return }
    box.classList.add('leaving')
    setTimeout(() => set(patch), LEAVE_MS)
  }

  let lastShown = null
  let positionFrame = 0
  const schedulePosition = () => {
    if (!positionFrame) positionFrame = requestAnimationFrame(() => { positionFrame = 0; position() })
  }

  // The panel is redrawn on every state change (each keystroke in a field,
  // each status change, typing in the email). Keep the list's scroll position
  // across redraws on the same screen, and play small opening animations only
  // when something actually opens, not on every redraw.
  let lastScreen = null
  let lastOpenId = null
  let lastMoreOpen = false
  let openingId = null
  let moreOpening = false

  function render() {
    const active = root.activeElement && root.activeElement.id
      ? { id: root.activeElement.id, pos: root.activeElement.selectionStart }
      : null
    const body = root.querySelector('.panel-body')
    const scrollTop = body ? body.scrollTop : 0
    const screen = S.view

    openingId = S.openId !== lastOpenId ? S.openId : null
    moreOpening = !!S.moreOpen && !lastMoreOpen
    lastOpenId = S.openId
    lastMoreOpen = !!S.moreOpen

    let h = ''
    if (S.view === 'ready') h = renderBar()
    else if (S.view === 'declined') h = renderBadge()
    else h = renderPanel()
    // Opening animations play only when what is shown changes, not on every
    // re-render (which happens on each keystroke in the panel's fields).
    const shown = panelOpen() ? 'panel' : S.view
    const enter = shown !== lastShown
    lastShown = shown
    root.innerHTML = `<style>${UI_CSS}</style><div class="root ${enter ? 'enter' : ''}">${h}</div>`
    const newBody = root.querySelector('.panel-body')
    if (newBody && screen === lastScreen) newBody.scrollTop = scrollTop
    lastScreen = screen
    position()

    if (active) {
      const el = root.getElementById(active.id)
      if (el) {
        el.focus({ preventScroll: true })
        if (el.setSelectionRange && active.pos != null) el.setSelectionRange(active.pos, active.pos)
      }
    }
  }

  // Collapsed: a round badge that opens into "Mostrar assistente" on hover or
  // keyboard focus, with the number of points still to do once there is a list.
  function renderBadge() {
    const pending = S.hadList ? S.points.filter((p) => pointState(p) !== 'done').length + S.outside.filter((o) => !o.done).length : 0
    const count = pending ? `<span class="fab-count" aria-hidden="true">${pending}</span>` : ''
    const label = pending ? `Mostrar assistente (${pending} por fazer)` : 'Mostrar assistente'
    return `<div class="chip-row"><button class="fab" data-a="reopen" aria-label="${label}" title="${label}">
      <span class="fab-icon">${SPARK(14)}</span><span class="fab-label">Mostrar assistente</span>${count}</button></div>`
  }

  function renderBar() {
    return `<div class="bar"><div class="bar-card">
      <span class="badge">${SPARK(18)}</span>
      <div class="bar-text"><strong>Quer ajuda com este pedido?</strong><span>O assistente pode preparar uma lista do que a resposta deve tratar. Só lê o email se clicar.</span></div>
      <button class="btn-primary" data-a="askList">Preparar a lista</button>
      <button class="btn-quiet" data-a="decline">Não, obrigado</button>
    <span class="mail-hint">Ou escreva a sua resposta, como sempre.</span></div></div>`
  }

  function renderPanel() {
    let h = `<aside class="panel" aria-label="Assistente DALM"><div class="panel-head" title="Arraste para mover · duplo clique para voltar ao lado"><span class="badge sm">${SPARK(13)}</span><strong>Assistente DALM</strong>
      <button class="link" data-a="openHelp">Como funciona</button><button class="link muted" data-a="hide">Esconder</button></div>`

    if (S.view === 'working' && S.error) {
      return h + `<div class="steps"><span class="message warn" role="alert">${esc(errorMessage(S.error))}</span>
        <div class="row"><button class="btn-primary" data-a="retry">Tentar outra vez</button><button class="btn-quiet" data-a="cancel">Cancelar</button></div></div></aside>`
    }

    if (S.view === 'working') {
      return h + `<div class="steps">` + S.stepTexts.map((t, i) => `<div class="step ${i > S.stepIdx ? 'pending' : ''}">${i < S.stepIdx ? TICK(18, '#2F8A63', 2.6) : '<span class="step-dots" aria-hidden="true">…</span>'}<span>${esc(t)}</span></div>`).join('') +
        `<div><button class="btn-secondary" data-a="cancel">Cancelar</button></div></div></aside>`
    }

    const writing = S.points.some((p) => p.writing)
    const wroteSomething = blocks.size > 0
    const toWrite = pointsToWrite()
    const regenerable = regenerableIds()
    const doneCount = S.points.filter((p) => pointState(p) === 'done').length
    const totalNeeds = aiNeeds().length
    const stepItems = S.steps.map((s) => `<li>${esc(s)}</li>`)
    if (totalNeeds) stepItems.push(`<li>${totalNeeds === 1 ? 'Não encontrei 1 informação (em «Falta saber»)' : `Não encontrei ${totalNeeds} informações (em «Falta saber»)`}</li>`)
    if (S.sources.length) stepItems.push(`<li>Fontes: ${S.sources.map(esc).join('; ')}</li>`)

    h += `<div class="panel-body">
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="summary">${TICK(15, '#5F8F7C', 2.6)}<span>${wroteSomething ? 'Escrevi a resposta no email' : 'Li o email e preparei esta lista'}</span>
        <button class="link" aria-expanded="${S.stepsOpen}" data-a="toggleSteps">${S.stepsOpen ? 'Esconder passos' : 'Ver passos'}</button></div>
        ${S.stepsOpen ? `<ul class="steplist">${stepItems.join('')}</ul>` : ''}
      </div>
      <p class="request"><strong>O pedido:</strong> ${esc(S.request)}</p>
      ${renderNeeds()}
      <div class="section">
        <div class="section-head"><strong>Plano de resposta:</strong>
          ${S.editing
            ? '<button class="link muted" data-a="cancelEdit">Anular</button><button class="link" data-a="finishEdit">Concluir</button>'
            : `<span>${doneCount} de ${S.points.length} feitos</span><button class="link" data-a="startEdit">Editar</button>`}</div>
        <span class="hint">${S.editing
          ? 'Mude o texto, apague ou acrescente passos. O plano é seu.'
          : `O assistente escreve os passos com <span class="legend">${ICON('robot', 14)}</span>; nos seus <span class="legend">${ICON('user', 14)}</span> deixa um espaço no texto.`}</span>
        <ul class="rows">${S.points.map(S.editing ? renderPointEdit : renderPoint).join('')}${S.editing ? renderNewStep() : ''}</ul></div>
      ${S.outside.length ? `<div class="section"><strong style="font-size:14px">Fora do email, faz você:</strong>
        <ul class="rows">${S.outside.map(renderOutside).join('')}</ul></div>` : ''}</div>`

    const missingInText = aiNeeds().filter((n) => !has(n.key) && S.points.some((p) => p.ai && p.needs.some((x) => x.key === n.key))).length
    const openSlots = S.points.filter((p) => pointState(p) === 'slot').length
    const outsideDone = S.outside.every((o) => o.done)
    let msg = ''
    let warn = false
    if (writing) msg = 'A escrever a resposta… pode demorar cerca de um minuto.'
    else if (S.genError) { msg = errorMessage(S.genError); warn = true }
    else if (missingInText > 0) { msg = missingInText === 1 ? 'Falta 1 informação no texto, entre [ ].' : `Faltam ${missingInText} informações no texto, entre [ ].`; warn = true }
    else if (openSlots > 0) msg = openSlots === 1 ? 'Escreva a sua parte no espaço marcado no texto.' : `Escreva a sua parte nos ${openSlots} espaços marcados no texto.`
    else if (doneCount === S.points.length && S.points.length) msg = outsideDone ? 'Tudo tratado. Envie quando quiser.' : 'Resposta tratada. Falta a tarefa fora do email.'

    // One obvious next step; everything else lives under "Mais".
    const more = [
      regenerable.length ? '<button class="menu-item" data-a="regenerate">Escrever outra versão</button>' : '',
      wroteSomething ? '<button class="menu-item" data-a="removeAI">Retirar o texto do assistente</button>' : ''
    ].join('')
    const buttons = writing
      ? '<button class="btn-secondary" data-a="cancelWriting">Cancelar</button>'
      : S.genError
      ? '<button class="btn-primary" data-a="retryGenerate">Tentar outra vez</button>'
      : (toWrite.length ? `<button class="btn-primary" data-a="generate">${SPARK(15)} ${wroteSomething ? 'Escrever o que falta' : 'Escrever a resposta'}</button>` : '') +
        (more ? `<button class="btn-more" data-a="toggleMore" aria-expanded="${!!S.moreOpen}" aria-haspopup="true">Mais ${ICON('chevron', 14)}</button>` : '')

    h += `<div class="panel-foot">${S.moreOpen && !writing ? `<div class="menu ${moreOpening ? 'opening' : ''}" role="menu">${more}</div>` : ''}
      ${msg ? `<span class="message ${warn ? 'warn' : ''}" role="status">${msg}</span>` : ''}<div class="row">${buttons}</div></div></aside>`
    return h
  }

  // The values the assistant could not find, for its own points, once each
  // (keys are shared across points). They fill its text and never leave the
  // browser.
  function aiNeeds() {
    const seen = new Map()
    for (const p of S.points) {
      if (p.owner !== 'ai') continue
      for (const n of p.needs) if (!seen.has(n.key)) seen.set(n.key, n)
    }
    return [...seen.values()]
  }

  function renderNeeds() {
    const needs = aiNeeds()
    if (!needs.length) return ''
    const missing = needs.filter((n) => !has(n.key)).length
    return `<div class="needs">
      <div class="section-head"><strong>Falta saber</strong><span>${missing ? `${missing} por preencher` : 'Tudo preenchido'}</span></div>
      <span class="hint">Não encontrei isto. Preencha ou deixe em branco: fica entre [ ] no texto.</span>
      ${needs.map((n) => `<div class="field"><label for="need-${n.key}">${esc(n.label)}</label><input id="need-${n.key}" class="${has(n.key) ? 'filled' : ''}" placeholder="não encontrei" value="${esc(S.values[n.key] || '')}" data-key="${n.key}"></div>`).join('')}
    </div>`
  }

  // Where a point is at. Shown, never clicked. The assistant's points are done
  // once written (no confirmation step) unless values are still missing; the
  // person's points are done once they type in their slot (or mark it).
  function pointState(p) {
    if (p.writing) return 'writing'
    if (p.owner === 'ai' && !p.done && p.needs.some((n) => !has(n.key))) return 'ask'
    if (p.ai || p.done) return 'done'
    const b = blocks.get(p.id)
    if (b && b.kind === 'slot' && b.el.isConnected) return 'slot'
    return 'todo'
  }

  const STATE_ICON = {
    todo: '<span class="dot"></span>',
    writing: '<span class="spin"></span>',
    ask: ICON('question', 18),
    slot: '<span class="ring"></span>',
    done: ICON('check', 18)
  }
  const STATE_LABEL = { todo: 'Por fazer', writing: 'A escrever', ask: 'Falta informação', slot: 'À espera do seu texto', done: 'Feito' }

  const actionButton = (action, label, title, id, kind, primary) =>
    `<button class="act ${primary ? 'primary' : ''}" data-a="${action}" data-id="${id}" data-kind="${kind}" aria-label="${label} «${esc(title)}»">${label}</button>`

  // One line per point; details open on click.
  function renderPoint(p) {
    const state = pointState(p)
    const isAI = p.owner === 'ai'
    const open = S.openId === p.id
    const owner = isAI ? 'o assistente' : 'você'
    return `<li class="row-item ${open ? 'open' : ''} ${openingId === p.id ? 'opening' : ''} ${hoverId === p.id ? 'hl' : ''}" data-pid="${p.id}" style="--pc:${colorOf(p.id)}">
      <button class="row-head" data-a="toggleRow" data-id="${p.id}" aria-expanded="${open}">
        <span class="state ${state}" role="img" aria-label="${STATE_LABEL[state]}">${STATE_ICON[state]}</span>
        <span class="pnum" aria-hidden="true">${S.points.indexOf(p) + 1}</span>
        <span class="row-text"><span class="row-title ${state === 'done' ? 'done' : ''}">${esc(p.title)}</span>${p.desc ? `<span class="row-sub">${esc(p.desc)}</span>` : ''}</span>
        <span class="row-owner ${isAI ? 'ai' : ''}" title="Escreve: ${owner}">${ICON(isAI ? 'robot' : 'user', 15)}</span>
        <span class="chev" aria-hidden="true">${ICON('chevron', 14)}</span>
      </button>
      ${open ? renderPointBody(p, state) : ''}
    </li>`
  }

  function renderPointBody(p, state) {
    const isAI = p.owner === 'ai'
    const locked = p.ai || p.writing
    const missing = p.needs.filter((n) => !has(n.key))
    let out = ''
    let action = ''
    if (state === 'writing') out = 'A escrever…'
    else if (isAI && state === 'ask') out = p.ai ? 'Escrito pelo assistente · falta informação em «Falta saber»' : 'Fica para o assistente · falta informação em «Falta saber»'
    else if (isAI) out = p.ai ? 'Escrito pelo assistente' : 'Fica para o assistente'
    else if (state === 'slot') out = 'Escreva no espaço marcado no texto'
    else if (state === 'done') {
      const b = blocks.get(p.id)
      out = 'Tratado por si'
      if (!(b && b.kind === 'slot' && b.el.isConnected)) action = actionButton('undoDone', 'Desfazer', p.title, p.id, 'point')
    } else {
      out = 'Fica para si'
      action = actionButton('markDone', 'Marcar como feito', p.title, p.id, 'point')
    }
    if (!isAI && missing.length && state !== 'done') out += ` · não encontrei: ${missing.map((n) => esc(n.label)).join(', ')}`
    return `<div class="row-body">
      ${renderSources(p)}
      <div class="seg" role="group" aria-label="Quem escreve «${esc(p.title)}»" ${locked ? `title="Retire o texto do assistente para mudar"` : ''}>
        <button data-a="setOwner" data-owner="user" data-id="${p.id}" aria-pressed="${!isAI}" ${locked ? 'disabled' : ''}>${ICON('user', 15)} Você</button>
        <button data-a="setOwner" data-owner="ai" data-id="${p.id}" aria-pressed="${isAI}" ${locked ? 'disabled' : ''}>${ICON('robot', 15)} Assistente</button>
      </div>
      <div class="out"><span>↳ ${out}</span>${action}</div>
    </div>`
  }

  // Editing the plan in place: each step's title and description become
  // fields, with ⊖ to delete it, and an empty last line with ⊕ to add one.
  // Changes apply as they are typed; "Anular" restores the plan as it was.
  function renderPointEdit(p) {
    const n = S.points.indexOf(p) + 1
    return `<li class="row-item editing" data-pid="${p.id}" style="--pc:${colorOf(p.id)}">
      <div class="row-head static">
        <span class="pnum" aria-hidden="true">${n}</span>
        <span class="edit-fields">
          <input id="et-${p.id}" class="edit-title" value="${esc(p.title)}" placeholder="Título do passo" aria-label="Título do passo ${n}" data-edit-field="title" data-id="${p.id}">
          <input id="ed-${p.id}" class="edit-desc" value="${esc(p.desc)}" placeholder="O que a resposta deve fazer" aria-label="Descrição do passo ${n}" data-edit-field="desc" data-id="${p.id}">
        </span>
        <button class="icon-btn" data-a="removePoint" data-id="${p.id}" aria-label="Apagar «${esc(p.title)}»" title="Apagar">${ICON('remove', 22)}</button>
      </div>
    </li>`
  }

  function renderNewStep() {
    return `<li class="row-item editing">
      <form class="row-head static" data-form="add">
        <span class="pnum ghost" aria-hidden="true">${S.points.length + 1}</span>
        <span class="edit-fields"><input id="new-step" class="edit-title" value="${esc(S.newText)}" placeholder="Novo passo, ex.: Indicar a quem contactar" aria-label="Novo passo" data-new="1"></span>
        <button class="icon-btn add" type="submit" aria-label="Acrescentar passo" title="Acrescentar">${ICON('add', 22)}</button>
      </form>
    </li>`
  }

  // Where a point came from (REDESIGN_PLAN.md E5), so people can judge it:
  // the past answers it rests on, in the staff's own words. A point for the
  // assistant with no source says so plainly.
  function renderSources(p) {
    const found = (p.sourceIds || []).map((id) => (S.sourceDetails || []).find((s) => s.id === id)).filter(Boolean)
    if (!found.length) return p.owner === 'ai' ? '<span class="srcs-none">Não encontrei uma resposta anterior sobre isto.</span>' : ''
    const when = (d) => {
      const date = new Date(d)
      return isNaN(date) ? '' : ` · ${date.toLocaleDateString('pt-PT', { month: 'short', year: 'numeric' })}`
    }
    return `<div class="srcs"><span class="srcs-head">Com base em ${found.length === 1 ? 'uma resposta anterior' : `${found.length} respostas anteriores`}:</span>
      ${found.map((s) => `<figure class="src"><figcaption>«${esc(s.question)}»${s.date ? when(s.date) : ''}</figcaption><blockquote>${esc(s.excerpt)}</blockquote></figure>`).join('')}
    </div>`
  }

  // Tasks outside the email are always the person's: no owner, no AI.
  function renderOutside(o) {
    const state = o.done ? 'done' : 'todo'
    return `<li class="row-item">
      <div class="row-head static">
        <span class="state ${state}" role="img" aria-label="${STATE_LABEL[state]}">${STATE_ICON[state]}</span>
        <span class="row-title plain ${o.done ? 'done' : ''}">${esc(o.text)}</span>
        ${o.done ? actionButton('undoDone', 'Desfazer', o.text, o.id, 'outside') : actionButton('markDone', 'Feito', o.text, o.id, 'outside')}
      </div>
    </li>`
  }

  function updateItem(el, patch) {
    const key = el.dataset.kind === 'outside' ? 'outside' : 'points'
    set({ [key]: S[key].map((x) => x.id === el.dataset.id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x) })
  }

  // --- The assistant's text in the email -------------------------------------
  // Each paragraph is a plain <div> in Gmail's editable body (one per point,
  // then an empty line), remembered with the text it was last written with.
  // While that text is unchanged the paragraph is the assistant's: values are
  // refilled and "Gerar outra versão" replaces it. Once the person edits it,
  // it is theirs: only its still-empty [placeholders] are filled in
  // (HANDOFF.md section 3 and open issue 6). Values never leave the browser.
  const blocks = new Map() // point id → { point, el, gap, segments, rendered }
  let frame = [] // greeting, thanks and sign-off lines: { el, rendered }
  let sent = null // the redacted thread and ticket sent to /list, reused for /generate
  let requester = '' // for the greeting; never sent

  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const untouched = (b) => b.el.isConnected && norm(b.el.textContent) === norm(b.rendered)

  function lineDiv(text) {
    const div = document.createElement('div')
    if (text) div.textContent = text
    else div.appendChild(document.createElement('br'))
    return div
  }

  const placeholder = (point, key) => {
    const need = point.needs.find((n) => n.key === key)
    return `[${need ? need.label : key}]`
  }
  const paragraphText = (point, segments) => segments
    .map((s) => s.slot ? (has(s.slot) ? S.values[s.slot].trim() : placeholder(point, s.slot)) : (s.text || ''))
    .join('')

  // Gmail's signature or quoted text, or our own sign-off: text goes above it.
  function tailAnchor() {
    const signoff = frame.find((f) => f.signoff && f.el.isConnected)
    if (signoff) return signoff.el
    return [...replyBox.children].find((c) => c.matches(GMAIL_TAIL) || c.querySelector(GMAIL_TAIL)) || null
  }

  // The next paragraph of a later point, so paragraphs follow the list order.
  function anchorAfter(pointId) {
    const ids = S.points.map((p) => p.id)
    for (const id of ids.slice(ids.indexOf(pointId) + 1)) {
      const b = blocks.get(id)
      if (b && b.el.parentNode === replyBox) return b.el
    }
    return tailAnchor()
  }

  function hasOwnText() {
    const tail = tailAnchor()
    for (const child of replyBox.children) {
      if (child === tail) break
      if (child.textContent.trim()) return true
    }
    return false
  }

  // Greeting and sign-off, only when the reply was empty.
  function addFrame() {
    if (frame.length || hasOwnText()) return
    const signature = [...replyBox.children].some((c) => c.matches(GMAIL_TAIL) || c.querySelector(GMAIL_TAIL))
    const top = [TEMPLATE.greeting(requester), '', TEMPLATE.thanks, '']
    const bottom = signature ? [TEMPLATE.signoff[0]] : TEMPLATE.signoff
    // Gmail starts an empty reply with a blank line; the template replaces it.
    const tail0 = tailAnchor()
    for (const child of [...replyBox.children]) {
      if (child === tail0) break
      if (!child.textContent.trim() && !child.querySelector('img')) child.remove()
    }
    const first = replyBox.firstChild
    for (const text of top) {
      const el = lineDiv(text)
      replyBox.insertBefore(el, first)
      frame.push({ el, rendered: text })
    }
    const tail = tailAnchor()
    bottom.forEach((text, i) => {
      const el = lineDiv(text)
      replyBox.insertBefore(el, tail)
      frame.push({ el, rendered: text, signoff: i === 0 })
    })
  }

  // Writes or replaces a point's paragraph. Returns false if the person has
  // edited it, in which case it is left alone.
  function placeParagraph(point, segments) {
    const text = paragraphText(point, segments)
    const existing = blocks.get(point.id)
    if (existing && existing.el.isConnected) {
      if (!untouched(existing)) return false
      existing.el.textContent = text
      Object.assign(existing, { point, kind: 'ai', segments, rendered: text })
      return true
    }
    insertBlock(point, { kind: 'ai', segments, rendered: text })
    return true
  }

  // A one-line slot where the person writes their own point, at its place in
  // the plan's order (REDESIGN_PLAN.md E7). Typing in it completes the point.
  function placeSlot(point) {
    const existing = blocks.get(point.id)
    if (existing && existing.el.isConnected) return
    insertBlock(point, { kind: 'slot', rendered: TEMPLATE.slot(point) })
  }

  function insertBlock(point, block) {
    const el = lineDiv(block.rendered)
    const gap = lineDiv('')
    const next = anchorAfter(point.id)
    const before = next && next.parentNode === replyBox ? next : null
    replyBox.insertBefore(el, before)
    replyBox.insertBefore(gap, before)
    blocks.set(point.id, { point, el, gap, ...block })
  }

  // Puts the values typed in the panel into the email.
  function refillParagraphs() {
    let changed = false
    for (const b of blocks.values()) {
      if (b.kind !== 'ai' || !b.el.isConnected) continue
      const point = S.points.find((p) => p.id === b.point.id) || b.point
      if (untouched(b)) {
        const text = paragraphText(point, b.segments)
        if (text !== b.rendered) { b.el.textContent = text; b.rendered = text; changed = true }
        continue
      }
      // Edited by the person: only fill placeholders still in the text.
      for (const s of b.segments) {
        if (!s.slot || !has(s.slot)) continue
        const mark = placeholder(point, s.slot)
        const walker = document.createTreeWalker(b.el, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue.includes(mark)) { node.nodeValue = node.nodeValue.replace(mark, S.values[s.slot].trim()); changed = true }
        }
      }
    }
    if (changed) tellGmail()
  }

  // Removes the assistant's paragraphs and the slots the person hasn't
  // written in; slots with the person's text stay.
  function removeAssistantText() {
    for (const [id, b] of [...blocks]) {
      if (b.kind === 'slot' && b.el.isConnected && !untouched(b)) continue
      b.el.remove()
      b.gap.remove()
      blocks.delete(id)
    }
    for (const f of frame) if (untouched(f)) f.el.remove()
    frame = []
    tellGmail()
  }

  // Gmail saves the draft on input events, not on DOM changes.
  const tellGmail = () => replyBox.dispatchEvent(new Event('input', { bubbles: true }))

  // Keeps the list in step with the email: a deleted paragraph or slot puts
  // its point back to "to do", and typing in a slot completes the point.
  function syncWithEmail() {
    const updates = {}
    for (const p of S.points) {
      const b = blocks.get(p.id)
      if (!b || p.writing) continue
      if (!b.el.isConnected) {
        if (b.gap.isConnected && !b.gap.textContent.trim()) b.gap.remove()
        blocks.delete(p.id)
        updates[p.id] = b.kind === 'ai' ? { ai: false } : { done: false }
        continue
      }
      if (b.kind === 'slot') {
        const typed = !untouched(b) && norm(b.el.textContent) !== ''
        if (typed !== !!p.done) updates[p.id] = { done: typed }
      }
    }
    if (Object.keys(updates).length) set({ points: S.points.map((p) => updates[p.id] ? { ...p, ...updates[p.id] } : p) })
    else renderSoon()
  }

  // Re-render shortly after typing in the email, so icons and counts follow.
  let renderTimer = null
  const renderSoon = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 300) }

  // What "Escrever a resposta" still has to do: the assistant's points not
  // yet written, and slots for the person's points that don't have one.
  function pointsToWrite() {
    return S.points.filter((p) => {
      if (p.writing || p.done || p.ai) return false
      if (p.owner === 'ai') return true
      const b = blocks.get(p.id)
      return !(b && b.el.isConnected)
    })
  }

  // Lays the reply out in the plan's order: asks /generate for the
  // assistant's points (if any) and adds slots for the person's. With
  // `again`, rewrites the assistant's untouched paragraphs, sending them as
  // `previous` so the backend writes a different version.
  function writeReply(again) {
    const aiIds = again ? regenerableIds() : pointsToWrite().filter((p) => p.owner === 'ai').map((p) => p.id)
    const slotIds = again ? [] : pointsToWrite().filter((p) => p.owner === 'user').map((p) => p.id)
    if ((!aiIds.length && !slotIds.length) || !sent) return
    stopWork()
    const token = workToken
    set({ moreOpen: false, genError: null, points: S.points.map((p) => aiIds.includes(p.id) ? { ...p, writing: true } : p) })
    const asked = S.points.filter((p) => aiIds.includes(p.id))

    const finish = (paragraphs) => {
      if (token !== workToken) return
      addFrame()
      const written = []
      for (const para of paragraphs) {
        const point = asked.find((p) => p.id === para.point)
        if (point && Array.isArray(para.segments) && placeParagraph(point, para.segments) !== false) written.push(point.id)
      }
      for (const p of S.points) if (slotIds.includes(p.id)) placeSlot(p)
      tellGmail()
      set({ points: S.points.map((p) => aiIds.includes(p.id) ? { ...p, writing: false, ai: p.ai || written.includes(p.id) } : p) })
    }

    if (!aiIds.length) { finish([]); return }
    const previous = again
      ? asked.map((p) => blocks.get(p.id)).filter(Boolean).map((b) => ({ point: b.point.id, segments: b.segments }))
      : null
    requestGenerate({
      ...sent,
      request_summary: S.request,
      points: asked.map(({ id, title, desc, needs }) => ({ id, title, desc, needs })),
      context_points: S.points.filter((p) => !aiIds.includes(p.id)).map(({ id, title, desc }) => ({ id, title, desc })),
      previous,
      instruction: null
    }).then(finish, (err) => {
      if (token !== workToken) return
      set({ genError: err, retryAgain: !!again, points: stopWriting() })
    })
  }

  const stopWriting = () => S.points.map((p) => p.writing ? { ...p, writing: false } : p)

  // "Escrever outra versão" rewrites the assistant's paragraphs the person
  // hasn't edited.
  const regenerableIds = () => S.points
    .filter((p) => p.ai && blocks.has(p.id) && blocks.get(p.id).kind === 'ai' && untouched(blocks.get(p.id)))
    .map((p) => p.id)

  // [placeholders] and untouched slots still in the email.
  function pendingInEmail() {
    let n = 0
    for (const b of blocks.values()) {
      if (!b.el.isConnected) continue
      if (b.kind === 'slot') { if (untouched(b)) n++; continue }
      const point = S.points.find((p) => p.id === b.point.id) || b.point
      const text = b.el.textContent
      for (const need of point.needs) if (text.includes(placeholder(point, need.key))) n++
    }
    return n
  }

  const actions = {
    // Explicit click (or the opt-in "Preparar sempre"): the only point where
    // the thread is read and sent.
    askList: () => runWork(STEPS_LIST, requestList(replyBox), (result) => {
      sent = result.sent
      requester = result.requester
      return { view: 'list', hadList: true, ...normalizeList(result.list), values: {}, stepsOpen: false, genError: null, openId: null, moreOpen: false }
    }, 'askList'),
    decline: () => leaveThen({ view: 'declined' }),
    reopen: () => set({ view: S.hadList ? 'list' : 'ready' }),
    hide: () => { stopWork(); leaveThen({ view: 'declined', points: stopWriting(), moreOpen: false }) },
    cancel: () => { stopWork(); set({ view: S.hadList ? 'list' : 'ready', error: null }) },
    retry: () => S.retry && actions[S.retry](),
    openHelp: () => showGuide(),
    toggleSteps: () => set({ stepsOpen: !S.stepsOpen }),
    toggleRow: (el) => {
      const opening = S.openId !== el.dataset.id
      set({ openId: opening ? el.dataset.id : null })
      if (opening) scrollToSection(el.dataset.id)
    },
    toggleMore: () => set({ moreOpen: !S.moreOpen }),
    setOwner: (el) => updateItem(el, { owner: el.dataset.owner }),
    markDone: (el) => updateItem(el, { done: true }),
    undoDone: (el) => updateItem(el, { done: false }),
    generate: () => writeReply(false),
    regenerate: () => writeReply(true),
    retryGenerate: () => writeReply(S.retryAgain),
    cancelWriting: () => { stopWork(); set({ points: stopWriting() }) },
    removeAI: () => {
      removeAssistantText()
      set({ moreOpen: false, points: S.points.map((p) => p.ai ? { ...p, ai: false } : p) })
      syncWithEmail()
    },
    startEdit: () => set({ editing: true, snapshot: S.points, newText: '', openId: null, moreOpen: false }),
    finishEdit: () => set({ editing: false, newText: '' }),
    // Restores the plan's text. A deleted step's section can't come back to
    // the email, so a restored step without one is "not written" again.
    cancelEdit: () => set({
      editing: false,
      newText: '',
      points: (S.snapshot || S.points).map((p) => blocks.has(p.id) ? p : { ...p, ai: false, done: p.ai ? false : p.done })
    }),
    // Deleting a step also removes its section from the email, but only if
    // it is untouched (the assistant's text as written, or an empty slot).
    removePoint: (el) => {
      const id = el.dataset.id
      const b = blocks.get(id)
      if (b) {
        if (b.el.isConnected && untouched(b)) {
          b.el.remove()
          if (b.gap.isConnected && !b.gap.textContent.trim()) b.gap.remove()
        }
        blocks.delete(id)
      }
      set({ points: S.points.filter((p) => p.id !== id) })
      if (b) tellGmail()
    }
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]')
    if (!el || el.tagName === 'INPUT') return
    if (actions[el.dataset.a]) actions[el.dataset.a](el)
  })
  root.addEventListener('input', (e) => {
    const t = e.target
    if (t.dataset.key) {
      set({ values: { ...S.values, [t.dataset.key]: t.value } })
      refillParagraphs()
    }
    else if (t.dataset.editField) {
      set({ points: S.points.map((p) => p.id === t.dataset.id ? { ...p, [t.dataset.editField]: t.value } : p) })
    } else if (t.dataset.new) set({ newText: t.value })
  })
  // A new step starts as the person's, with its text as the title; its
  // description can be filled in on its own line right away.
  root.addEventListener('submit', (e) => {
    e.preventDefault()
    const title = S.newText.trim()
    if (!title) return
    set({ newText: '', points: S.points.concat([{ id: 'n' + Date.now(), title, desc: '', needs: [], owner: 'user', sourceIds: [], done: false, ai: false, writing: false }]) })
  })

  // Typing in the reply collapses the ready bar into "Mostrar assistente".
  replyBox.addEventListener('input', () => {
    if (S.view === 'ready') leaveThen({ view: 'declined' })
    else syncWithEmail()
  })

  // Open issue 9: a reminder next to Gmail's Enviar while [placeholders] or
  // untouched slots remain. It never blocks sending: it only shows while the
  // button is hovered or focused, and nothing stops the click.
  let tip = null
  function sendButtonFrom(el) {
    const btn = el && el.closest && el.closest('[role="button"][data-tooltip]')
    if (!btn || !/^(Enviar|Send)\b/.test(btn.getAttribute('data-tooltip') || '')) return null
    const thread = findThreadView(replyBox)
    return thread && thread.contains(btn) ? btn : null
  }
  function showTip(btn) {
    const n = pendingInEmail()
    if (!n) return
    if (!tip) {
      tip = document.createElement('div')
      tip.dataset.dalmHost = ''
      tip.style.pointerEvents = 'none'
      tip.attachShadow({ mode: 'open' })
      document.body.appendChild(tip)
    }
    tip.shadowRoot.innerHTML = `<style>${UI_CSS}</style><div class="root enter"><div class="send-tip" role="status">${ICON('question', 16)}<span>${n === 1 ? 'O texto ainda tem 1 espaço por preencher entre [ ].' : `O texto ainda tem ${n} espaços por preencher entre [ ].`}</span></div></div>`
    const r = btn.getBoundingClientRect()
    tip.style.display = ''
    tip.style.left = `${Math.max(EDGE, r.left)}px`
    tip.style.top = `${Math.max(EDGE, r.top - 52)}px`
  }
  const hideTip = () => { if (tip) tip.style.display = 'none' }
  const onOver = (e) => { const btn = sendButtonFrom(e.target); if (btn) showTip(btn) }
  const onOut = (e) => { const btn = sendButtonFrom(e.target); if (btn && !btn.contains(e.relatedTarget)) hideTip() }
  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('focusin', onOver, true)
  document.addEventListener('focusout', hideTip, true)

  // Follow the reply as the conversation scrolls or the window resizes.
  window.addEventListener('scroll', schedulePosition, true)
  window.addEventListener('resize', schedulePosition)
  const resizeObserver = new ResizeObserver(schedulePosition)
  resizeObserver.observe(replyBox)

  // Gmail removes the reply box when it's closed or sent; poll for that since
  // there's no reliable event for it. The poll also catches Gmail hiding the
  // reply (e.g. switching to another conversation) without removing it.
  const cleanupInterval = setInterval(() => {
    if (replyBox.isConnected) { position(); return }
    clearTimeout(timer)
    clearInterval(cleanupInterval)
    resizeObserver.disconnect()
    window.removeEventListener('scroll', schedulePosition, true)
    window.removeEventListener('resize', schedulePosition)
    document.removeEventListener('mouseover', onOver, true)
    document.removeEventListener('mouseout', onOut, true)
    document.removeEventListener('focusin', onOver, true)
    document.removeEventListener('focusout', hideTip, true)
    if (tip) tip.remove()
    marks.remove()
    host.remove()
  }, 1000)

  render()
  if (!prefs.guideSeen) showGuide()
  if (prefs.prepareAlways) actions.askList()
}

async function attachToReplyBox(replyBox) {
  if (replyBox.dataset.dalmAttached) return
  // The assistant lives only in inline replies to an open thread.
  if (!findThreadView(replyBox)) return
  replyBox.dataset.dalmAttached = 'true'
  injectPageStyles()
  await prefsReady
  if (replyBox.isConnected) createAssistant(replyBox)
}

// Watch for Gmail reply boxes being added to the DOM
const observer = new MutationObserver(() => {
  // An orphaned copy (see extensionAlive) stops watching; the fresh copy
  // that Chrome injects when Gmail is reloaded takes over.
  if (!extensionAlive()) { observer.disconnect(); return }
  document.querySelectorAll('div[role="textbox"][aria-label]')
    .forEach(attachToReplyBox)
})

observer.observe(document.body, { childList: true, subtree: true })
