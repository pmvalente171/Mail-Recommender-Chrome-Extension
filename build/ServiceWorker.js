// Service worker: the only part of the extension that talks to the backend
// (docs/handoff/HANDOFF.md, section 4). The content script sends it text that
// has already had personal data removed in the page.

const BACKEND_URL = 'http://localhost:4000'

// Mock backend: answer from canned data instead of calling BACKEND_URL, until
// the real /list endpoint exists. In the thread, "!erro" simulates a backend
// failure and "!vazio" an empty list. What the mock receives is logged here,
// in the service worker's console (chrome://extensions → "service worker"),
// so the redaction can be checked; it never reaches the Gmail page's console.
const MOCK_BACKEND = true
const MOCK_DELAY_MS = 2500

chrome.runtime.onInstalled.addListener(() => {
  console.log('Mail Recommender installed.')
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'dalm:list') return false
  requestList(message.payload)
    .then((list) => sendResponse({ ok: true, list }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }))
  return true // keep the channel open for the async response
})

async function requestList(payload) {
  if (MOCK_BACKEND) return mockList(payload)
  const res = await fetch(`${BACKEND_URL}/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`Backend returned ${res.status}`)
  return res.json()
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
