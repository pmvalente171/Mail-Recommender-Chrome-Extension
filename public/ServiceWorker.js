// Service worker: the only part of the extension that talks to the backend
// (docs/handoff/HANDOFF.md, section 4). The content script sends it text that
// has already had personal data removed in the page.

// The backend's address, this PC's access key and its study participant ID
// (docs/BACKEND_SPEC.md, sections 6–8) come from config.js, which the build
// writes from config.local.json. The origin must be in "host_permissions" in
// manifest.json, which lets this service worker call the backend without CORS.
import { BACKEND_URL, API_KEY, PARTICIPANT } from './config.js'

// The backend gives up after 120 s (docs/BACKEND_SPEC.md, section 8). Wait a bit
// longer, so its own timeout normally fires first with a proper error.
const REQUEST_TIMEOUT_MS = 150000
// Chrome stops an idle extension service worker after 30 s. Calling an
// extension API resets that timer, so ping one while a request is pending.
const KEEPALIVE_MS = 20000

// Mock backend: answer from canned data instead of calling BACKEND_URL. In the
// thread, "!erro" simulates a backend failure and "!vazio" an empty list.
// Either way, requests and responses are logged here, in the service worker's
// console (chrome://extensions → "service worker"), so the redaction and the
// backend's output can be checked; they never reach the Gmail page's console.
const MOCK_BACKEND = false
const MOCK_DELAY_MS = 2500

// Study events that could not be sent wait in chrome.storage.local (this
// worker can be stopped at any time) and go out with the next batch.
const LOG_BACKLOG_KEY = 'dalmLogBacklog'
const LOG_BACKLOG_MAX = 5000

chrome.runtime.onInstalled.addListener(() => {
  console.log('Mail Recommender installed.')
})

// The participant goes with every call, so the backend can apply the study's
// settings and consent (BACKEND_SPEC.md §6). Without one, nothing is stored.
const withParticipant = (payload) => PARTICIPANT ? { ...payload, participant: PARTICIPANT } : payload

// Message type → backend call, and the mock that stands in for it.
const ROUTES = {
  'dalm:list': { path: '/list', call: (p) => request('POST', '/list', withParticipant(p)), mock: (p) => mockList(p) },
  'dalm:generate': { path: '/generate', call: (p) => request('POST', '/generate', withParticipant(p)), mock: (p) => mockGenerate(p) },
  'dalm:config': { path: '/config', call: () => request('GET', `/config?participant=${encodeURIComponent(PARTICIPANT)}`), mock: () => mockConfig() },
  'dalm:log': { path: '/log', call: (p) => sendLog(p.events), mock: (p) => mockLog(p.events) }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = ROUTES[message.type]
  if (!route) return false
  callBackend(route, message.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.warn(`[${route.path}] failed:`, err.message || err)
      sendResponse({ ok: false, error: String(err.message || err) })
    })
  return true // keep the channel open for the async response
})

async function callBackend(route, payload) {
  if (MOCK_BACKEND) return route.mock(payload)
  console.log(`[${route.path}] request to ${BACKEND_URL}`, payload)
  const data = await route.call(payload)
  console.log(`[${route.path}] response`, data)
  return data
}

// Sends study events with the ones left over from earlier failures, oldest
// first. On failure they all wait for the next batch. Without a participant ID
// the backend would store nothing, so nothing is sent. One batch at a time, so
// a backlog is never sent twice.
let logChain = Promise.resolve()
function sendLog(events) {
  const run = logChain.then(async () => {
    if (!PARTICIPANT) return { skipped: 'no participant ID in config.local.json' }
    const stored = await chrome.storage.local.get({ [LOG_BACKLOG_KEY]: [] })
    const batch = stored[LOG_BACKLOG_KEY].concat((events || []).map((e) => ({ ...e, participant: PARTICIPANT })))
    if (!batch.length) return { sent: 0 }
    try {
      await request('POST', '/log', { events: batch })
      await chrome.storage.local.set({ [LOG_BACKLOG_KEY]: [] })
      return { sent: batch.length }
    } catch (err) {
      await chrome.storage.local.set({ [LOG_BACKLOG_KEY]: batch.slice(-LOG_BACKLOG_MAX) })
      throw new Error(`${err.message || err} (${batch.length} events kept for the next batch)`)
    }
  })
  logChain = run.catch(() => {})
  return run
}

// Errors carry the backend's own message ({ "error": "…" }) for the logs; the
// page shows a generic one either way. A 204 (from /log) returns null.
async function request(method, path, payload) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_MS)
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(API_KEY ? { 'X-API-Key': API_KEY } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    })
    const body = await res.json().catch(() => null)
    if (res.status === 401) {
      throw new Error(API_KEY
        ? 'Invalid API key (401): check apiKey in config.local.json, then rebuild'
        : 'Missing API key (401): add apiKey to config.local.json, then rebuild')
    }
    if (!res.ok) throw new Error((body && body.error) || `Backend returned ${res.status}`)
    return body
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`No response from ${path} after ${REQUEST_TIMEOUT_MS / 1000} s`)
    throw err
  } finally {
    clearTimeout(timeout)
    clearInterval(keepAlive)
  }
}

// Shaped like GET /config (BACKEND_SPEC.md §6). Consent is on, so the mock
// shows the events with their "content" in this console.
async function mockConfig() {
  return { phase: 2, generate_enabled: true, text_logging_consent: true }
}

async function mockLog(events) {
  for (const e of events || []) console.log('[mock /log]', e.event, e)
  return null
}

// Shaped like the POST /list response in HANDOFF.md section 4. The content is
// the prototype's example; the values it asks for are left for the person.
async function mockList(payload) {
  console.log('[mock /list] received', payload)
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS))

  if (payload.thread.includes('!erro')) throw new Error('Mock backend failure')

  const steps = ['Li o email', 'Percebi o pedido', 'Procurei a informação nas fontes a que tenho acesso']
  if (payload.thread.includes('!vazio')) {
    return { request_summary: 'não consegui perceber o que o email pede.', points: [], outside: [], steps, sources: [] }
  }

  return {
    request_summary: 'um encarregado de educação quer saber se a Licenciatura em Análise e Engenharia de Dados abre vagas em 2026/27 e quais as condições de acesso.',
    // owner: the backend's suggestion of who handles each point ('ai' or
    // 'user'); the person can switch it in the panel.
    points: [
      { id: 'c2', title: 'Vagas', desc: 'dizer quantas vagas há no concurso de 2026/27.', needs: [{ key: 'vagas', label: 'N.º de vagas', question: 'Quantas vagas tem o curso no concurso de 2026/27?', type: 'number', hint: 'ex.: 25', options: [] }], owner: 'ai', source_ids: ['s1'] },
      { id: 'c3', title: 'Condições de acesso', desc: 'indicar as provas de ingresso e a nota mínima.', needs: [{ key: 'provas', label: 'Provas de ingresso', question: 'Quais são as provas de ingresso?', type: 'text', options: [] }, { key: 'nota', label: 'Nota mínima', question: 'Qual é a nota mínima de candidatura?', type: 'text', options: [] }], owner: 'ai', source_ids: ['s1'] },
      { id: 'c4', title: 'Candidatura', desc: 'explicar onde e quando se candidata.', needs: [{ key: 'datas', label: 'Datas da 1.ª fase', question: 'Quando decorre a 1.ª fase de candidatura?', type: 'date', hint: 'ex.: 15/09/2026', options: [{ value: '20 de julho', source_id: 's1', time_sensitive: true }] }], owner: 'ai', source_ids: ['s1'] },
      { id: 'c5', title: 'Site', desc: 'lamentar que a informação ainda não esteja no nosso site.', needs: [], owner: 'user', source_ids: [] }
    ],
    outside: [{ id: 'o1', text: 'Pedir à equipa do site que publique a página do curso.' }],
    steps,
    sources: ['Resposta anterior da DALM: «Quais as condições de acesso à licenciatura?» (simulada)'],
    source_details: [{ id: 's1', question: 'Quais as condições de acesso à licenciatura? (simulada)', excerpt: 'As condições de acesso estão na página do curso; a 1.ª fase decorreu até 20 de julho… (texto simulado)', date: null }]
  }
}

// Shaped like the POST /generate response (docs/BACKEND_SPEC.md, section 5):
// one paragraph per requested point, with a slot for each of its needs.
async function mockGenerate(payload) {
  console.log('[mock /generate] received', payload)
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS))
  if (payload.thread.includes('!erro')) throw new Error('Mock backend failure')
  const version = payload.previous ? ' (outra versão)' : ''
  return {
    paragraphs: payload.points.map((p) => ({
      point: p.id,
      segments: [
        { text: `[Texto simulado${version}] Sobre «${p.title}»: ${p.desc}` },
        ...p.needs.flatMap((n) => [{ text: ` ${n.label}: ` }, { slot: n.key }, { text: '.' }])
      ]
    }))
  }
}
