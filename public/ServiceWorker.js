// Service worker: the only part of the extension that talks to the backend
// (docs/handoff/HANDOFF.md, section 4). The content script sends it text that
// has already had personal data removed in the page.

// Keep in sync with "host_permissions" in manifest.json, which lets this
// service worker call the backend without CORS.
const BACKEND_URL = 'http://localhost:4000'

// The backend can take over a minute (docs/BACKEND_SPEC.md, section 8). Give up
// after this, so its own timeout normally fires first with a proper error.
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

chrome.runtime.onInstalled.addListener(() => {
  console.log('Mail Recommender installed.')
})

// Message type → backend endpoint, and the mock that stands in for it.
const ROUTES = {
  'dalm:list': { path: '/list', mock: (payload) => mockList(payload) },
  'dalm:generate': { path: '/generate', mock: (payload) => mockGenerate(payload) }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = ROUTES[message.type]
  if (!route) return false
  callBackend(route, message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.warn(`[${route.path}] failed:`, err.message || err)
      sendResponse({ ok: false, error: String(err.message || err) })
    })
  return true // keep the channel open for the async response
})

async function callBackend(route, payload) {
  if (MOCK_BACKEND) return route.mock(payload)
  console.log(`[${route.path}] request`, payload)
  const data = await postJSON(route.path, payload)
  console.log(`[${route.path}] response`, data)
  return data
}

// Errors carry the backend's own message ({ "error": "…" }) for the logs; the
// page shows a generic one either way.
async function postJSON(path, payload) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_MS)
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    const body = await res.json().catch(() => null)
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
      { id: 'c2', title: 'Vagas', desc: 'dizer quantas vagas há no concurso de 2026/27.', needs: [{ key: 'vagas', label: 'N.º de vagas' }], owner: 'ai' },
      { id: 'c3', title: 'Condições de acesso', desc: 'indicar as provas de ingresso e a nota mínima.', needs: [{ key: 'provas', label: 'Provas de ingresso' }, { key: 'nota', label: 'Nota mínima' }], owner: 'ai' },
      { id: 'c4', title: 'Candidatura', desc: 'explicar onde e quando se candidata.', needs: [{ key: 'datas', label: 'Datas da 1.ª fase' }], owner: 'ai' },
      { id: 'c5', title: 'Site', desc: 'lamentar que a informação ainda não esteja no nosso site.', needs: [], owner: 'user' }
    ],
    outside: [{ id: 'o1', text: 'Pedir à equipa do site que publique a página do curso.' }],
    steps,
    sources: ['Exemplo do protótipo (resposta simulada, sem backend)']
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
