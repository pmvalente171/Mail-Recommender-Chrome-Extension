// Content script: detects Gmail compose boxes and offers a "Draft reply" action
// that calls the DALM backend to generate a full Portuguese registrar reply.

const RECOMMEND_ENDPOINT = "http://localhost:4000/recommend"

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
      max-width: 320px;
      z-index: 99999;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      display: none;
    `
    document.body.appendChild(tooltip)
  }
  return tooltip
}

function showNotice(button, text) {
  const tooltip = getNoticeTooltip()
  const rect = button.getBoundingClientRect()
  tooltip.style.left = `${rect.left}px`
  tooltip.style.top = `${rect.bottom + 6}px`
  tooltip.textContent = text
  tooltip.style.display = 'block'
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

function replaceComposeBoxText(composeBox, text) {
  composeBox.focus()
  composeBox.textContent = text
  composeBox.dispatchEvent(new Event('input', { bubbles: true }))
}

function positionOverComposeBox(element, composeBox) {
  const rect = composeBox.getBoundingClientRect()
  element.style.top = `${rect.top + 6}px`
  element.style.left = `${rect.right - element.offsetWidth - 6}px`
}

function createDraftButton(composeBox) {
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
  `

  button.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    hideNotice()

    const text = composeBox.innerText || composeBox.textContent
    if (!text.trim()) {
      showNotice(button, 'Write something first.')
      return
    }

    const originalLabel = button.textContent
    button.textContent = 'Drafting…'
    button.disabled = true

    try {
      const result = await fetchRecommendation(text)
      if (result.in_scope && result.reply) {
        replaceComposeBoxText(composeBox, result.reply)
      } else {
        showNotice(button, 'This does not look like a DALM-related question, so no reply was drafted.')
      }
    } catch (err) {
      showNotice(button, 'Could not reach the recommender backend.')
    } finally {
      button.textContent = originalLabel
      button.disabled = false
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
