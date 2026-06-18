// Content script: detects Gmail compose boxes and offers a "Draft reply" action
// that calls the DALM backend to generate a full Portuguese registrar reply.

const RECOMMEND_ENDPOINT = "http://localhost:4000/recommend"

function injectSpinnerStyle() {
  if (document.getElementById('mail-recommender-style')) return
  const style = document.createElement('style')
  style.id = 'mail-recommender-style'
  style.textContent = `
    @keyframes mail-recommender-spin { to { transform: rotate(360deg); } }
    .mail-recommender-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 6px;
      border: 2px solid #aecbfa;
      border-top-color: #1a73e8;
      border-radius: 50%;
      animation: mail-recommender-spin 0.6s linear infinite;
      vertical-align: middle;
    }
  `
  document.head.appendChild(style)
}

let lastMouseX = 0
let lastMouseY = 0
document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX
  lastMouseY = e.clientY
  const tooltip = document.getElementById('mail-recommender-notice')
  if (tooltip && tooltip.style.display === 'block') {
    positionNoticeAtCursor(tooltip)
  }
})

function positionNoticeAtCursor(tooltip) {
  const offset = 16
  const rect = tooltip.getBoundingClientRect()
  let left = lastMouseX + offset
  let top = lastMouseY + offset
  if (left + rect.width > window.innerWidth) left = lastMouseX - rect.width - offset
  if (top + rect.height > window.innerHeight) top = lastMouseY - rect.height - offset
  tooltip.style.left = `${Math.max(left, 0)}px`
  tooltip.style.top = `${Math.max(top, 0)}px`
}

function getNoticeTooltip() {
  let tooltip = document.getElementById('mail-recommender-notice')
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.id = 'mail-recommender-notice'
    tooltip.style.cssText = `
      position: fixed;
      background: white;
      border: 1px solid #dadce0;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 13px;
      color: #3c4043;
      max-width: 280px;
      z-index: 99999;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      display: none;
      pointer-events: none;
    `
    document.body.appendChild(tooltip)
  }
  return tooltip
}

function showNotice(text) {
  const tooltip = getNoticeTooltip()
  tooltip.textContent = text
  tooltip.style.display = 'block'
  positionNoticeAtCursor(tooltip)
}

function hideNotice() {
  const tooltip = document.getElementById('mail-recommender-notice')
  if (tooltip) tooltip.style.display = 'none'
}

async function fetchRecommendation(text) {
  const res = await fetch(RECOMMEND_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: text })
  })
  if (!res.ok) throw new Error(`Backend returned ${res.status}`)
  return res.json()
}

function extractOriginalEmail(composeBox) {
  // Gmail embeds the original message as a hidden blockquote inside the
  // reply compose box (behind the "Show trimmed content" "..." toggle).
  // textContent reads it regardless of its collapsed/hidden state, unlike innerText.
  const quote = composeBox.querySelector('blockquote.gmail_quote, blockquote[class*="quote"], div.gmail_quote')
  if (quote && quote.textContent.trim()) return quote.textContent.trim()

  // Fallback: the rendered message body of the thread being replied to.
  const thread = composeBox.closest('[role="main"]') || document
  const bodies = thread.querySelectorAll('.a3s.aiL')
  if (bodies.length) return bodies[bodies.length - 1].textContent.trim()

  return ''
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function replaceComposeBoxText(composeBox, text) {
  composeBox.focus()
  // Plain '\n' characters don't create line breaks in a contenteditable div;
  // each line needs to be its own block element, matching Gmail's own markup.
  composeBox.innerHTML = escapeHtml(text)
    .split('\n')
    .map((line) => `<div>${line || '<br>'}</div>`)
    .join('')
  composeBox.dispatchEvent(new Event('input', { bubbles: true }))
}

function positionOverComposeBox(element, composeBox) {
  const rect = composeBox.getBoundingClientRect()
  // Anchor from the right edge (not left) so the button growing wider while
  // loading ("Draft reply" -> spinner + "Drafting reply...") expands inward
  // instead of overflowing past the compose box's right border.
  element.style.top = `${rect.top + 6}px`
  element.style.right = `${window.innerWidth - rect.right + 6}px`
  element.style.left = 'auto'
}

function createDraftButton(composeBox) {
  injectSpinnerStyle()

  const button = document.createElement('button')
  button.textContent = 'Draft reply'
  button.style.cssText = `
    position: fixed;
    z-index: 99999;
    padding: 4px 10px;
    font-size: 12px;
    border: 1px solid #dadce0;
    border-radius: 4px;
    background: #f8f9fa;
    color: #1a73e8;
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  `
  button.dataset.busy = 'false'

  button.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    hideNotice()

    const draft = (composeBox.innerText || composeBox.textContent || '').trim()
    const original = extractOriginalEmail(composeBox)
    const text = original ? (draft ? `${original}\n\n${draft}` : original) : draft
    if (!text) {
      showNotice('Write something, or open an email to reply to, first.')
      return
    }

    const originalLabel = button.textContent
    button.dataset.busy = 'true'
    button.disabled = true
    button.style.cursor = 'default'
    button.style.background = '#e8f0fe'
    button.innerHTML = '<span class="mail-recommender-spinner"></span>Drafting reply…'
    showNotice('Drafting a reply — this can take up to a minute, hang tight…')

    try {
      const result = await fetchRecommendation(text)
      if (result.in_scope && result.reply) {
        replaceComposeBoxText(composeBox, result.reply)
        hideNotice()
      } else {
        showNotice('This does not look like a DALM-related question, so no reply was drafted.')
      }
    } catch (err) {
      showNotice('Could not reach the recommender backend.')
    } finally {
      button.dataset.busy = 'false'
      button.disabled = false
      button.style.cursor = 'pointer'
      button.style.background = '#f8f9fa'
      button.textContent = originalLabel
    }
  })

  return button
}

function attachToComposeBox(composeBox) {
  if (composeBox.dataset.mailRecommenderAttached) return
  composeBox.dataset.mailRecommenderAttached = 'true'

  const button = createDraftButton(composeBox)
  document.body.appendChild(button)
  positionOverComposeBox(button, composeBox)

  const reveal = () => {
    button.style.opacity = '1'
    button.style.pointerEvents = 'auto'
  }
  const conceal = () => {
    if (button.dataset.busy === 'true') return
    button.style.opacity = '0'
    button.style.pointerEvents = 'none'
  }
  composeBox.addEventListener('mouseenter', reveal)
  composeBox.addEventListener('mouseleave', conceal)
  button.addEventListener('mouseenter', reveal)
  button.addEventListener('mouseleave', conceal)

  const reposition = () => positionOverComposeBox(button, composeBox)
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)

  // Gmail removes the compose box from the DOM when it's closed; poll for
  // that since there's no reliable event for it.
  const cleanupInterval = setInterval(() => {
    if (!composeBox.isConnected) {
      button.remove()
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      clearInterval(cleanupInterval)
    }
  }, 1000)

  composeBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNotice()
  })
}

// Watch for Gmail compose boxes being added to the DOM
const observer = new MutationObserver(() => {
  document.querySelectorAll('div[role="textbox"][aria-label]')
    .forEach(attachToComposeBox)
})

observer.observe(document.body, { childList: true, subtree: true })
