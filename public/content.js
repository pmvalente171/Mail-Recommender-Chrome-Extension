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
async function requestList(replyBox) {
  const thread = readThread(replyBox)
  if (!thread || !thread.text) throw new Error('No thread text')
  const names = thread.messages.map((m) => m.from).filter(Boolean)
  const response = await chrome.runtime.sendMessage({
    type: 'dalm:list',
    payload: { thread: redact(thread.text, names), ticket: await sha256(thread.threadId) }
  })
  if (!response || !response.ok) throw new Error(response ? response.error : 'No response')
  return response.list
}

// Fills in defaults so the panel never has to guess at missing fields.
function normalizeList(list) {
  return {
    request: list.request_summary || '',
    points: (list.points || []).map((p, i) => ({
      id: String(p.id || `p${i}`), title: p.title || '', desc: p.desc || '',
      needs: p.needs || [], done: false, ai: false
    })),
    outside: (list.outside || []).map((o, i) => ({ id: String(o.id || `o${i}`), text: o.text || '', done: false })),
    steps: list.steps || [],
    sources: list.sources || []
  }
}

const STEPS_LIST = ['A ler o email', 'A perceber o pedido', 'A procurar a informação nas fontes a que tenho acesso']
const STEPS_GENERATE = ['A juntar a lista e a informação que me deu', 'A escrever os pontos por marcar']
const STEPS_REGENERATE = ['A escrever outra versão']
const STEP_DELAY_MS = 650

// Short plain messages for failures (HANDOFF.md open issue 8).
function errorMessage(err) {
  if (err && err.message === 'No thread text') return 'Não consegui ler o email desta conversa.'
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
  chrome.storage.sync.set({ [key]: value }).catch(() => {})
}

// --- Styles -----------------------------------------------------------------
// Tokens and component styles ported from docs/handoff/prototype.html.
const UI_CSS = `
:host{all:initial;
  --green-900:#173F33; --green-700:#1F5C4A; --green-600:#2F8A63; --green-300:#8FB3A3;
  --green-200:#A9C9BB; --green-100:#EAF3EF; --green-50:#F2F7F4; --panel-line:#E3EBE7; --panel-border:#C9D8D0;
  --ink:#1E2421; --ink-2:#3D4F48; --ink-3:#5F6F68; --ink-4:#80868B;
  --amber-text:#6B4E00; --amber-field:#FFFBEF; --amber-field-line:#E2C76E;
  --danger-line:#E3B4B4; --danger-ink:#8A2C2C;
  --font-ui:'Public Sans DALM','Helvetica Neue',Arial,sans-serif;
  --font-mail:Arial,Helvetica,sans-serif}
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
.bar-card{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 16px;background:var(--green-50);border:1px solid var(--green-200);border-radius:12px}
.badge{flex:0 0 auto;width:34px;height:34px;border-radius:50%;background:var(--green-700);color:#fff;display:flex;align-items:center;justify-content:center}
.badge.sm{width:24px;height:24px}
.bar-text{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:2px}
.bar-text strong{font-size:15px;color:var(--green-900)}
.bar-text span{font-size:13.5px;color:var(--ink-2)}
.mail-hint{font-family:var(--font-mail);font-size:14px;color:var(--ink-4);padding-left:2px}
.chip-row{display:flex;justify-content:flex-end}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;padding:0 16px;min-height:40px;border-radius:20px;border:1px solid var(--green-200);background:var(--green-50);color:var(--green-700)}

.panel{display:flex;flex-direction:column;background:#fff;border:1px solid var(--panel-border);border-radius:14px;overflow:hidden;height:var(--panel-height,560px)}
.panel.top{height:auto;max-height:520px}
.panel-head{display:flex;align-items:center;gap:6px;padding:12px 16px;border-bottom:1px solid var(--panel-line)}
.panel-head strong{flex:1 1 auto;font-size:15px;color:var(--green-900)}
.panel-body{flex:1 1 auto;overflow-y:auto;padding:14px 18px 10px;display:flex;flex-direction:column;gap:14px}
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
.crit{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.crit li{display:flex;gap:10px;align-items:flex-start;padding:6px;margin:0 -6px;border-radius:10px}
.crit li.review{background:#EEF6F1}
.check{flex:0 0 auto;width:26px;height:26px;padding:0;border-radius:50%;border:2px solid #9DB5AA;background:#fff;color:#fff;display:flex;align-items:center;justify-content:center}
.check.ai{border-color:var(--green-700)}
.check[aria-checked="true"]{border-color:var(--green-600);background:var(--green-600)}
.crit-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px}
.crit-text{font-size:14px;line-height:1.45}
.crit-text.done{color:var(--ink-3)}
.status{font-size:12px;font-weight:600;color:var(--ink-3)}
.status.review{color:var(--green-700)}
.field{display:flex;align-items:center;gap:8px}
.field label{flex:0 0 auto;width:118px;font-size:12.5px;color:var(--amber-text)}
.field input,.edit input{flex:1 1 auto;min-width:0;font:inherit;font-size:13.5px;padding:0 10px;min-height:34px;border:1px solid var(--amber-field-line);border-radius:8px;background:var(--amber-field);color:var(--ink)}
.field input.filled{border-color:#C4CDC8;background:#fff}
.outside{display:flex;gap:10px;align-items:flex-start}
.outside span{font-size:14px;line-height:1.45}
.outside span.done{color:var(--ink-3)}
.message{font-size:13px;font-weight:600;color:var(--green-700)}
.message.warn{color:var(--amber-text)}
.persist{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--ink-3)}
.persist input{width:15px;height:15px;margin:2px 0 0;accent-color:var(--green-700)}
.edit-head{padding:12px 18px;border-bottom:1px solid var(--panel-line);display:flex;flex-direction:column;gap:2px}
.edit-head strong{font-size:15px;color:var(--green-900)}
.edit-head span{font-size:13px;color:var(--ink-2)}
.edit{display:flex;gap:6px;align-items:center}
.edit input{border-color:#C4CDC8;background:#fff;min-height:38px;padding:0 12px}
.edit input.new{border-style:dashed;border-color:var(--green-300)}
.btn-danger{flex:0 0 auto;font-size:12.5px;font-weight:600;padding:0 10px;min-height:38px;border-radius:8px;border:1px solid var(--danger-line);background:#fff;color:var(--danger-ink)}
.btn-add{flex:0 0 auto;font-size:12.5px;font-weight:600;padding:0 12px;min-height:38px;border-radius:8px;border:1px solid var(--green-300);background:#fff;color:var(--green-700)}

.guide{background:#fff;border:1px solid var(--green-200);border-radius:16px;box-shadow:0 12px 32px rgba(23,40,34,.22);padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--green-700)}
.guide > strong{font-size:19px;line-height:1.25;color:var(--green-900)}
.guide ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;font-size:14.5px}
.guide li{display:flex;gap:12px;align-items:flex-start}
.num{flex:0 0 auto;width:24px;height:24px;border-radius:50%;background:var(--green-100);color:var(--green-700);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
`

// Page-level styles: the font, and the anchor for our host element.
const PANEL_WIDTH = 400
const PANEL_HEIGHT = 560
const PANEL_MIN_HEIGHT = 320
const PANEL_GAP = 16
const TOOLBAR_FALLBACK = 64 // if Gmail's formatting toolbar can't be found
const NARROW_BELOW = 820 // reply body narrower than this: panel goes above the text

function injectPageStyles() {
  if (document.getElementById('dalm-page-style')) return
  const style = document.createElement('style')
  style.id = 'dalm-page-style'
  const font = chrome.runtime.getURL('fonts/public-sans-latin-wght-normal.woff2')
  style.textContent = `
    @font-face{font-family:'Public Sans DALM';font-style:normal;font-weight:100 900;font-display:swap;
      src:url(${font}) format('woff2-variations'),url(${font}) format('woff2')}
    [data-dalm-parent]{position:relative !important}
    [data-dalm-host]{display:block;position:absolute;z-index:2;margin:0}
  `
  document.head.appendChild(style)
}

// Gmail listens for keyboard shortcuts on the page. Key events from inside a
// shadow root are retargeted to the host, so typing "c" in one of our fields
// would open a new message. Stop them (and clicks) at the host.
function isolateEvents(host) {
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'mousedown', 'mouseup', 'click']) {
    host.addEventListener(type, (e) => e.stopPropagation())
  }
}

// --- Rendering helpers ------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const SPARK = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>`
const TICK = (s, color, w) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`

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
    <li><span class="num">2</span><span>Marque os pontos que já tratou. Se faltar informação, preencha-a ou deixe em branco.</span></li>
    <li><span class="num">3</span><span>Se quiser, clique em <strong>Gerar o que falta</strong>: o assistente só escreve os pontos por marcar. Leia o texto e marque cada ponto. <strong>Nada é enviado sem si.</strong></span></li>
    </ol><div><button class="btn-primary" data-a="closeGuide">Percebi</button></div></div>`
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
  const parent = replyBox.parentElement
  const host = document.createElement('div')
  host.dataset.dalmHost = ''
  isolateEvents(host)
  const root = host.attachShadow({ mode: 'open' })
  parent.dataset.dalmParent = ''
  parent.insertBefore(host, replyBox)

  // Gmail's own spacing, so ours is added on top of it rather than replacing it.
  const base = getComputedStyle(replyBox)
  const basePadTop = parseFloat(base.paddingTop) || 0
  const basePadRight = parseFloat(base.paddingRight) || 0
  const baseMinHeight = replyBox.style.minHeight
  const baseParentPadRight = parseFloat(getComputedStyle(parent).paddingRight) || 0

  let S = {
    view: 'ready', // 'ready' | 'declined' | 'working' | 'list'
    request: '', points: [], outside: [], steps: [], sources: [], values: {},
    editing: false, snapshot: null, newText: '',
    stepTexts: [], stepIdx: 0, stepsOpen: false, hadList: false,
    error: null, retry: null
  }
  let timer = null
  let workToken = 0 // bumped on cancel, so a late response is ignored
  let narrow = false

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

  function currentMode() {
    const panelOpen = S.view === 'working' || S.view === 'list'
    return panelOpen && !narrow ? 'side' : 'top'
  }

  // The host floats over the reply body and space is made for it so the
  // person's text starts clear of it. Above the text (bar, chip, narrow panel)
  // the editable gets padding-top. Beside the text (side panel) the space goes
  // on the editable's *parent* instead: Gmail sizes the editable at 100% of
  // its parent, so padding on the editable itself makes it overflow and get
  // clipped by an outer overflow:hidden container. Only inline styles change,
  // never the editable's content, so none of this is sent with the email.
  function layout() {
    if (!replyBox.isConnected) return
    const mode = currentMode()
    host.style.top = `${replyBox.offsetTop}px`
    if (mode === 'side') {
      const height = sidePanelHeight()
      host.style.left = 'auto'
      host.style.right = `${baseParentPadRight}px`
      host.style.width = `${PANEL_WIDTH}px`
      host.style.setProperty('--panel-height', `${height}px`)
      parent.style.setProperty('padding-right', `${baseParentPadRight + PANEL_WIDTH + PANEL_GAP}px`, 'important')
      replyBox.style.setProperty('padding-top', `${basePadTop}px`, 'important')
      replyBox.style.setProperty('min-height', `${height}px`, 'important')
    } else {
      parent.style.setProperty('padding-right', `${baseParentPadRight}px`, 'important')
      host.style.left = `${replyBox.offsetLeft}px`
      host.style.right = 'auto'
      host.style.width = `${replyBox.offsetWidth - basePadRight}px`
      replyBox.style.setProperty('padding-top', `${basePadTop + host.offsetHeight + 8}px`, 'important')
      replyBox.style.minHeight = baseMinHeight
    }
  }

  // Gmail's reply body is a scroll area with the formatting toolbar floating
  // over its bottom edge. Fit the side panel between the top of the editable
  // and that toolbar, so its footer buttons are never hidden underneath.
  const scroller = (() => {
    for (let n = parent.parentElement; n; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n
    }
    return null
  })()

  function sidePanelHeight() {
    if (!scroller) return PANEL_HEIGHT
    const box = scroller.getBoundingClientRect()
    // Top of the editable in the scroller's content coordinates, so the
    // result doesn't change as the reply body scrolls.
    const top = replyBox.getBoundingClientRect().top - box.top + scroller.scrollTop
    const toolbar = [...scroller.querySelectorAll('[role="toolbar"]')]
      .map((t) => t.getBoundingClientRect())
      .find((r) => r.height > 0 && r.top < box.bottom && r.bottom > box.top)
    const covered = toolbar ? box.bottom - toolbar.top : TOOLBAR_FALLBACK
    const available = scroller.clientHeight - top - covered - PANEL_GAP
    return Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_HEIGHT, Math.round(available)))
  }

  function render() {
    const mode = currentMode()
    host.dataset.dalmMode = mode

    const active = root.activeElement && root.activeElement.id
      ? { id: root.activeElement.id, pos: root.activeElement.selectionStart }
      : null

    let h = ''
    if (S.view === 'ready') h = renderBar()
    else if (S.view === 'declined') h = `<div class="chip-row"><button class="chip" data-a="reopen">${SPARK(15)} Mostrar assistente</button></div>`
    else h = renderPanel(mode)
    root.innerHTML = `<style>${UI_CSS}</style><div class="root">${h}</div>`
    layout()

    if (active) {
      const el = root.getElementById(active.id)
      if (el) {
        el.focus()
        if (el.setSelectionRange && active.pos != null) el.setSelectionRange(active.pos, active.pos)
      }
    }
  }

  function renderBar() {
    return `<div class="bar"><div class="bar-card">
      <span class="badge">${SPARK(18)}</span>
      <div class="bar-text"><strong>Quer ajuda com este pedido?</strong><span>O assistente pode preparar uma lista do que a resposta deve tratar. Só lê o email se clicar.</span></div>
      <button class="btn-primary" data-a="askList">Preparar a lista</button>
      <button class="btn-quiet" data-a="decline">Não, obrigado</button>
    </div><span class="mail-hint">Ou escreva a sua resposta aqui, como sempre.</span></div>`
  }

  function renderPanel(mode) {
    let h = `<aside class="panel ${mode === 'top' ? 'top' : ''}" aria-label="Assistente DALM"><div class="panel-head"><span class="badge sm">${SPARK(13)}</span><strong>Assistente DALM</strong>
      <button class="link" data-a="openHelp">Como funciona</button><button class="link muted" data-a="hide">Esconder</button></div>`

    if (S.view === 'working' && S.error) {
      return h + `<div class="steps"><span class="message warn" role="alert">${esc(errorMessage(S.error))}</span>
        <div class="row"><button class="btn-primary" data-a="retry">Tentar outra vez</button><button class="btn-quiet" data-a="cancel">Cancelar</button></div></div></aside>`
    }

    if (S.view === 'working') {
      return h + `<div class="steps">` + S.stepTexts.map((t, i) => `<div class="step ${i > S.stepIdx ? 'pending' : ''}">${i < S.stepIdx ? TICK(18, '#2F8A63', 2.6) : '<span class="step-dots" aria-hidden="true">…</span>'}<span>${esc(t)}</span></div>`).join('') +
        `<div><button class="btn-secondary" data-a="cancel">Cancelar</button></div></div></aside>`
    }

    if (S.editing) {
      return h + `<div class="edit-head"><strong>A editar a lista</strong><span>Mude o texto, apague ou acrescente pontos. A lista é sua.</span></div>
        <div class="panel-body" style="gap:8px">` +
        S.points.map((p) => `<div class="edit"><input id="edit-${p.id}" aria-label="Ponto da lista" value="${esc(p.title + ': ' + p.desc)}" data-edit="${p.id}"><button class="btn-danger" data-a="removePoint" data-id="${p.id}">Apagar</button></div>`).join('') +
        `<form class="edit" data-form="add"><input id="new-point" class="new" aria-label="Novo ponto" placeholder="Novo ponto, ex.: Contacto: indicar a quem perguntar" value="${esc(S.newText)}" data-new="1"><button class="btn-add" type="submit">Acrescentar</button></form></div>
        <div class="panel-foot" style="flex-direction:row"><button class="btn-primary" style="font-size:14px;min-height:42px" data-a="finishEdit">Concluir</button><button class="btn-quiet" style="font-size:14px" data-a="cancelEdit">Cancelar alterações</button></div></aside>`
    }

    const anyAI = S.points.some((p) => p.ai)
    const toWrite = S.points.filter((p) => !p.done && !p.ai)
    const doneCount = S.points.filter((p) => p.done).length
    const totalNeeds = S.points.reduce((n, p) => n + p.needs.length, 0)
    const stepItems = S.steps.map((s) => `<li>${esc(s)}</li>`)
    if (totalNeeds) stepItems.push(`<li>${totalNeeds === 1 ? 'Não encontrei 1 informação (marcada abaixo)' : `Não encontrei ${totalNeeds} informações (marcadas abaixo)`}</li>`)
    if (S.sources.length) stepItems.push(`<li>Fontes: ${S.sources.map(esc).join('; ')}</li>`)

    h += `<div class="panel-body">
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="summary">${TICK(15, '#5F8F7C', 2.6)}<span>${anyAI ? 'Escrevi os pontos que estavam por marcar' : 'Li o email e preparei esta lista'}</span>
        <button class="link" aria-expanded="${S.stepsOpen}" data-a="toggleSteps">${S.stepsOpen ? 'Esconder passos' : 'Ver passos'}</button></div>
        ${S.stepsOpen ? `<ul class="steplist">${stepItems.join('')}</ul>` : ''}
      </div>
      <p class="request"><strong>O pedido:</strong> ${esc(S.request)}</p>
      <div class="section">
        <div class="section-head"><strong>A resposta deve tratar:</strong><span>${doneCount} de ${S.points.length} tratados</span></div>
        <span class="hint">${anyAI ? 'Marque cada ponto quando estiver satisfeito com o texto.' : 'Marque os pontos que já tratou. O assistente só escreve os que ficarem por marcar.'}</span>
        <ul class="crit">` + S.points.map((p) => {
          const missing = p.needs.filter((n) => !has(n.key))
          let status = ''
          let cls = ''
          if (p.ai && !p.done) { status = 'Escrito pelo assistente · leia o texto e marque'; cls = 'review' }
          else if (p.ai && p.done) status = 'Escrito pelo assistente · revisto por si'
          else if (p.done) status = 'Tratado por si'
          const showFields = !p.done || missing.length > 0
          return `<li class="${p.ai && !p.done ? 'review' : ''}">
            <button class="check ${p.ai ? 'ai' : ''}" role="checkbox" aria-checked="${p.done}" aria-label="Marcar «${esc(p.title)}» como tratado" data-a="toggle" data-id="${p.id}">${p.done ? TICK(14, 'currentColor', 3) : ''}</button>
            <div class="crit-main"><span class="crit-text ${p.done ? 'done' : ''}"><strong>${esc(p.title)}</strong>: ${esc(p.desc)}</span>
            ${status ? `<span class="status ${cls}">${status}</span>` : ''}
            ${showFields ? p.needs.map((n) => `<div class="field"><label for="need-${n.key}">${esc(n.label)}</label><input id="need-${n.key}" class="${has(n.key) ? 'filled' : ''}" placeholder="não encontrei" value="${esc(S.values[n.key] || '')}" data-key="${n.key}"></div>`).join('') : ''}
            </div></li>`
        }).join('') + `</ul></div>
      ${S.outside.length ? `<div style="display:flex;flex-direction:column;gap:6px"><strong style="font-size:14px">Fora do email, faz você:</strong>
        ${S.outside.map((o) => `<div class="outside"><button class="check" role="checkbox" aria-checked="${o.done}" aria-label="Marcar como feito: ${esc(o.text)}" data-a="toggleOutside" data-id="${o.id}">${o.done ? TICK(14, 'currentColor', 3) : ''}</button><span class="${o.done ? 'done' : ''}">${esc(o.text)}</span></div>`).join('')}
      </div>` : ''}</div>`

    const missingInText = S.points.filter((p) => p.ai).reduce((n, p) => n + p.needs.filter((x) => !has(x.key)).length, 0)
    const unreviewed = S.points.filter((p) => p.ai && !p.done).length
    const outsideDone = S.outside.every((o) => o.done)
    let msg = ''
    let warn = false
    if (missingInText > 0) { msg = missingInText === 1 ? 'Falta 1 informação, a amarelo no texto.' : `Faltam ${missingInText} informações, a amarelo no texto.`; warn = true }
    else if (unreviewed > 0) msg = 'Leia o texto do assistente e marque cada ponto.'
    else if (doneCount === S.points.length && S.points.length) msg = outsideDone ? 'Tudo tratado. Envie quando quiser.' : 'Resposta tratada. Falta a tarefa fora do email.'

    h += `<div class="panel-foot">${msg ? `<span class="message ${warn ? 'warn' : ''}">${msg}</span>` : ''}<div class="row">
      ${toWrite.length ? `<button class="btn-primary" data-a="generate">${SPARK(15)} ${toWrite.length === S.points.length ? 'Gerar resposta' : `Gerar o que falta (${toWrite.length})`}</button>` : ''}
      ${anyAI ? `<button class="btn-secondary" data-a="regenerate">Gerar outra versão</button><button class="link muted" data-a="removeAI">Retirar texto do assistente</button>` : `<button class="link" data-a="startEdit">Editar lista</button>`}
      </div><label class="persist"><input type="checkbox" id="always" ${prefs.prepareAlways ? 'checked' : ''} data-a="toggleAlways">Preparar esta lista sempre que abro uma resposta (fica guardado)</label></div></aside>`
    return h
  }

  // Generating only flags points in the panel for now; calling /generate and
  // inserting the text into the email is build step 5.
  const actions = {
    // Explicit click (or the opt-in "Preparar sempre"): the only point where
    // the thread is read and sent.
    askList: () => runWork(STEPS_LIST, requestList(replyBox),
      (list) => ({ view: 'list', hadList: true, ...normalizeList(list), values: {}, stepsOpen: false }), 'askList'),
    decline: () => set({ view: 'declined' }),
    reopen: () => set({ view: S.hadList ? 'list' : 'ready' }),
    hide: () => { stopWork(); set({ view: 'declined' }) },
    cancel: () => { stopWork(); set({ view: S.hadList ? 'list' : 'ready', error: null }) },
    retry: () => S.retry && actions[S.retry](),
    openHelp: () => showGuide(),
    toggleSteps: () => set({ stepsOpen: !S.stepsOpen }),
    toggle: (el) => set({ points: S.points.map((p) => p.id === el.dataset.id ? { ...p, done: !p.done } : p) }),
    toggleOutside: (el) => set({ outside: S.outside.map((o) => o.id === el.dataset.id ? { ...o, done: !o.done } : o) }),
    generate: () => {
      const ids = S.points.filter((p) => !p.done && !p.ai).map((p) => p.id)
      runWork(STEPS_GENERATE, Promise.resolve(), () => ({ view: 'list', points: S.points.map((p) => ids.includes(p.id) ? { ...p, ai: true } : p) }), 'generate')
    },
    regenerate: () => runWork(STEPS_REGENERATE, Promise.resolve(), () => ({ view: 'list' }), 'regenerate'),
    removeAI: () => set({ points: S.points.map((p) => p.ai ? { ...p, ai: false, done: false } : p) }),
    startEdit: () => set({ editing: true, snapshot: S.points }),
    finishEdit: () => set({ editing: false }),
    cancelEdit: () => set({ editing: false, points: S.snapshot || S.points }),
    removePoint: (el) => set({ points: S.points.filter((p) => p.id !== el.dataset.id) })
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]')
    if (!el || el.tagName === 'INPUT') return
    if (actions[el.dataset.a]) actions[el.dataset.a](el)
  })
  root.addEventListener('change', (e) => {
    if (e.target.dataset.a === 'toggleAlways') {
      savePref('prepareAlways', e.target.checked)
      render()
    }
  })
  root.addEventListener('input', (e) => {
    const t = e.target
    if (t.dataset.key) set({ values: { ...S.values, [t.dataset.key]: t.value } })
    else if (t.dataset.edit) {
      const v = t.value
      const i = v.indexOf(':')
      const patch = i >= 0 ? { title: v.slice(0, i).trim(), desc: v.slice(i + 1).trim() } : { title: v.trim(), desc: '' }
      set({ points: S.points.map((p) => p.id === t.dataset.edit ? { ...p, ...patch } : p) })
    } else if (t.dataset.new) set({ newText: t.value })
  })
  root.addEventListener('submit', (e) => {
    e.preventDefault()
    const v = S.newText.trim()
    if (!v) return
    const i = v.indexOf(':')
    const item = i >= 0 ? { title: v.slice(0, i).trim(), desc: v.slice(i + 1).trim() } : { title: v, desc: '' }
    set({ newText: '', points: S.points.concat([{ id: 'n' + Date.now(), needs: [], done: false, ai: false, ...item }]) })
  })

  // Typing in the reply collapses the ready bar into "Mostrar assistente".
  replyBox.addEventListener('input', () => {
    if (S.view === 'ready') set({ view: 'declined' })
  })

  // Re-anchor when the reply box or our own content changes size, and put the
  // panel above the text when the reply body is too narrow for a column.
  // The parent's clientWidth includes its padding, so it doesn't change when
  // the side panel adds padding-right, and the layout can't flip-flop.
  const resizeObserver = new ResizeObserver(() => {
    const isNarrow = parent.clientWidth < NARROW_BELOW
    if (isNarrow !== narrow) { narrow = isNarrow; render() } else layout()
  })
  resizeObserver.observe(parent)
  resizeObserver.observe(replyBox)
  resizeObserver.observe(host)
  if (scroller) resizeObserver.observe(scroller)

  // Gmail removes the reply box when it's closed or sent; poll for that since
  // there's no reliable event for it.
  const cleanupInterval = setInterval(() => {
    if (replyBox.isConnected) return
    clearTimeout(timer)
    clearInterval(cleanupInterval)
    resizeObserver.disconnect()
    host.remove()
  }, 1000)

  narrow = parent.clientWidth < NARROW_BELOW
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
  document.querySelectorAll('div[role="textbox"][aria-label]')
    .forEach(attachToReplyBox)
})

observer.observe(document.body, { childList: true, subtree: true })
