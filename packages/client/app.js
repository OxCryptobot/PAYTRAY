let experts = [
  {
    id: 'jordan-mitchell',
    initials: 'JM',
    name: 'Jordan Mitchell',
    role: 'Protocol engineer',
    domain: 'protocol',
    location: 'New York · UTC−5',
    rate: '$185 / hr',
    availability: 'Available today',
    availabilityKey: 'today',
    score: '98',
    context: 'You need an ERC-20 streaming adapter with a resilient reconciliation path.',
    tags: ['Solidity', 'DeFi', 'Streams'],
    avatar: 'linear-gradient(135deg, #b9c4c4, #6c837f)',
    wallet: '0x2222222222222222222222222222222222222222'
  },
  {
    id: 'maya-singh',
    initials: 'MS',
    name: 'Maya Singh',
    role: 'Product systems strategist',
    domain: 'product',
    location: 'London · UTC+0',
    rate: '$150 / hr',
    availability: 'Available this week',
    availabilityKey: 'week',
    score: '96',
    context: 'You need a sharper expert-to-engagement path without hiding payment uncertainty.',
    tags: ['Product', 'Marketplace', 'AI'],
    avatar: 'linear-gradient(135deg, #d4a4a1, #7d5668)',
    wallet: '0x3333333333333333333333333333333333333333'
  },
  {
    id: 'eli-rodriguez',
    initials: 'ER',
    name: 'Eli Rodríguez',
    role: 'Realtime product designer',
    domain: 'design',
    location: 'Austin · UTC−6',
    rate: '$125 / hr',
    availability: 'Available today',
    availabilityKey: 'today',
    score: '93',
    context: 'You need a calm workspace that keeps collaboration useful while a stream confirms.',
    tags: ['UX systems', 'Realtime', 'Wallets'],
    avatar: 'linear-gradient(135deg, #dfc487, #876648)',
    wallet: '0x4444444444444444444444444444444444444444'
  },
  {
    id: 'noah-williams',
    initials: 'NW',
    name: 'Noah Williams',
    role: 'Trust & risk engineer',
    domain: 'protocol',
    location: 'Toronto · UTC−5',
    rate: '$165 / hr',
    availability: 'Available this week',
    availabilityKey: 'week',
    score: '91',
    context: 'You need outcome signals that improve matching without allowing reputation poisoning.',
    tags: ['Risk', 'Data lineage', 'Security'],
    avatar: 'linear-gradient(135deg, #9ba7d3, #58669b)',
    wallet: '0x5555555555555555555555555555555555555555'
  }
]

const state = { selectedId: null, query: '', domain: 'all', availability: 'all', engagementId: null, paymentIntentId: null, queryId: null, discoveryMode: 'phase1_client_fixture' }
let walletSession = null
const list = document.querySelector('#expert-list')
const resultCount = document.querySelector('#result-count')
const searchInput = document.querySelector('#search-input')
const domainFilter = document.querySelector('#domain-filter')
const availabilityFilter = document.querySelector('#availability-filter')
const emptyEngagement = document.querySelector('#empty-engagement')
const selectedEngagement = document.querySelector('#selected-engagement')
const panelTitle = document.querySelector('#panel-title')
const streamStatus = document.querySelector('#stream-status')
const liveDiscoveryButton = document.querySelector('#load-live-discovery')

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function normalizeLiveExpert(profile) {
  const expertise = Array.isArray(profile.expertise) ? profile.expertise.map((item) => String(item)) : []
  const availabilityKey = String(profile.availability || 'unknown').toLowerCase()
  const availability = availabilityKey === 'today' ? 'Available today' : availabilityKey === 'this_week' ? 'Available this week' : `Available: ${availabilityKey}`
  const name = profile.name || 'PayTray expert'
  return {
    id: profile.id,
    initials: name.split(/\\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
    name,
    role: expertise[0] || 'Verified expert',
    domain: expertise[0] || 'general',
    location: profile.timezone || 'Remote · flexible timezone',
    rate: profile.hourlyRate == null ? 'Rate on request' : `$${Number(profile.hourlyRate).toFixed(0)} / hr`,
    availability,
    availabilityKey: availabilityKey === 'this_week' ? 'week' : availabilityKey,
    score: String(profile.matchScore ?? 0),
    context: (profile.matchExplanation?.matchedFilters || []).length ? `Fit signals: ${profile.matchExplanation.matchedFilters.join(', ')}.` : 'Fit is based on the current verified discovery profile.',
    tags: expertise.slice(0, 4),
    avatar: 'linear-gradient(135deg, #9ba7d3, #58669b)',
    wallet: profile.wallet,
    matchExplanation: profile.matchExplanation
  }
}

async function loadLiveDiscovery() {
  if (!window.PAYTRAY_API_BASE) {
    showStatus('Set PAYTRAY_API_BASE to enable live discovery; the fixture list remains active.', 'error')
    return
  }
  try {
    showStatus('Connecting wallet to load durable discovery results…')
    const session = await ensureWalletSession()
    const queryId = window.crypto?.randomUUID?.() || `client-query-${Date.now()}`
    const url = new URL(`${session.apiBase}/api/v2/discovery/experts`)
    if (state.query.trim()) url.searchParams.set('q', state.query.trim())
    if (state.availability !== 'all') url.searchParams.set('availability', state.availability === 'week' ? 'this_week' : state.availability)
    const response = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}`, 'x-query-id': queryId } })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `Live discovery failed (${response.status})`)
    experts = (payload.experts || []).map(normalizeLiveExpert)
    state.queryId = payload.queryId || queryId
    state.discoveryMode = 'durable_discovery_v1'
    state.selectedId = null
    state.engagementId = null
    state.paymentIntentId = null
    emptyEngagement.classList.remove('hidden')
    selectedEngagement.classList.add('hidden')
    renderExperts()
    showStatus(`Loaded ${experts.length} durable expert result${experts.length === 1 ? '' : 's'} with query lineage ${state.queryId}.`, 'success')
  } catch (error) {
    showStatus(`Live discovery unavailable: ${error.message}. Fixture results remain available.`, 'error')
  }
}

function filteredExperts() {
  const query = state.query.toLowerCase().trim()
  return experts.filter((expert) => {
    const searchable = [expert.name, expert.role, expert.context, ...expert.tags].join(' ').toLowerCase()
    const matchesQuery = !query || searchable.includes(query)
    const matchesDomain = state.domain === 'all' || expert.domain === state.domain
    const matchesAvailability = state.availability === 'all' || expert.availabilityKey === state.availability
    return matchesQuery && matchesDomain && matchesAvailability
  })
}

function renderExperts() {
  const visible = filteredExperts()
  resultCount.textContent = `${visible.length} expert${visible.length === 1 ? '' : 's'}`
  if (!visible.length) {
    list.innerHTML = '<div class="empty-state"><p>No experts match this brief yet.</p><span>Try a broader skill, domain, or availability filter.</span></div>'
    return
  }

  list.innerHTML = visible.map((expert) => `
    <article class="expert-card ${state.selectedId === expert.id ? 'selected' : ''}" data-expert-id="${escapeHtml(expert.id)}" tabindex="0" role="button" aria-pressed="${state.selectedId === expert.id}" aria-label="View fit for ${escapeHtml(expert.name)}">
      <div class="expert-main">
        <div class="avatar" style="background:${escapeHtml(expert.avatar)}">${escapeHtml(expert.initials)}</div>
        <div class="expert-info">
          <div class="expert-topline"><span class="expert-name">${escapeHtml(expert.name)}</span><span class="verified-badge">✓ Verified</span></div>
          <span class="expert-role">${escapeHtml(expert.role)}</span>
          <div class="expert-meta"><span class="location">${escapeHtml(expert.location)}</span><span class="rate">${escapeHtml(expert.rate)}</span><span class="available">${escapeHtml(expert.availability)}</span></div>
          <div class="expert-tags">${expert.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="expert-score"><span class="score">${escapeHtml(expert.score)}%</span><span class="score-label">MATCH QUALITY</span><button class="select-expert" data-select-id="${escapeHtml(expert.id)}">View fit →</button></div>
    </article>
  `).join('')
}

function selectExpert(id) {
  const expert = experts.find((candidate) => candidate.id === id)
  if (!expert) return
  state.selectedId = id
  document.querySelector('#panel-avatar').textContent = expert.initials
  document.querySelector('#panel-avatar').style.background = expert.avatar
  document.querySelector('#panel-expert').textContent = expert.name
  document.querySelector('#panel-role').textContent = expert.role
  document.querySelector('#panel-context').textContent = expert.context
  document.querySelector('#panel-tags').innerHTML = expert.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')
  document.querySelector('#panel-rate').textContent = '0.0003472 USDC / sec'
  document.querySelector('#panel-start').textContent = '30 minutes'
  panelTitle.textContent = 'A considered fit.'
  emptyEngagement.classList.add('hidden')
  selectedEngagement.classList.remove('hidden')
  streamStatus.className = 'stream-status hidden'
  renderExperts()
  document.querySelector('#engagement').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function showStatus(message, type = '') {
  streamStatus.textContent = message
  streamStatus.className = `stream-status ${type}`
}

async function authenticateWallet({ apiBase, walletProvider, wallet, chainId }) {
  const challengeResponse = await fetch(`${apiBase}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, chainId })
  })
  const challengePayload = await challengeResponse.json()
  if (!challengeResponse.ok) throw new Error(challengePayload.error || `Challenge failed (${challengeResponse.status})`)

  const message = challengePayload.challenge.message
  const signature = await walletProvider.request({ method: 'personal_sign', params: [message, wallet] })
  const loginResponse = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wallet,
      signature,
      challengeId: challengePayload.challenge.id,
      message,
      chainId
    })
  })
  const loginPayload = await loginResponse.json()
  if (!loginResponse.ok) throw new Error(loginPayload.error || `Wallet login failed (${loginResponse.status})`)
  return loginPayload.tokens.accessToken
}

async function ensureWalletSession() {
  if (walletSession) return walletSession
  const walletProvider = window.ethereum
  if (!walletProvider) throw new Error('Wallet connection is not available in this browser')
  const apiBase = window.PAYTRAY_API_BASE || 'http://localhost:3001'
  const accounts = await walletProvider.request({ method: 'eth_requestAccounts' })
  const wallet = accounts?.[0]
  if (!wallet) throw new Error('No wallet account returned')
  const chainId = 84532
  const networkHex = await walletProvider.request({ method: 'eth_chainId' })
  if (Number.parseInt(networkHex, 16) !== chainId) throw new Error('Switch your wallet to Base Sepolia before continuing')
  const accessToken = await authenticateWallet({ apiBase, walletProvider, wallet, chainId })
  walletSession = { apiBase, wallet, accessToken, chainId }
  return walletSession
}

async function startEngagement() {
  const expert = experts.find((candidate) => candidate.id === state.selectedId)
  if (!expert) return
  try {
    showStatus('Sign the PayTray wallet challenge to carry this match into a private engagement.')
    const session = await ensureWalletSession()
    const response = await fetch(`${session.apiBase}/api/v2/engagements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        providerWallet: expert.wallet,
        searchBrief: expert.context,
        discoveryContext: { source: state.discoveryMode, queryId: state.queryId, expertId: expert.id, role: expert.role, tags: expert.tags, availability: expert.availability },
        rankingExplanation: { version: 1, matchScore: Number(expert.score) / 100, source: state.discoveryMode, matchExplanation: expert.matchExplanation || null },
        proposedTerms: { chainId: session.chainId, tokenAddress: '0x1111111111111111111111111111111111111111', ratePerSecondBaseUnits: '3472' }
      })
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `Engagement request failed (${response.status})`)
    state.engagementId = payload.engagement.id
    state.paymentIntentId = null
    showStatus(`Engagement ${payload.engagement.id} is ready. Thread ${payload.engagement.thread_id} is separate from payment settlement. Create a payment intent only when you are ready to fund time.`, 'success')
  } catch (error) {
    showStatus(`Engagement not created: ${error.message}`, 'error')
  }
}

async function refreshPaymentStatus() {
  if (!state.engagementId) {
    showStatus('Create the engagement context before refreshing verified status.', 'error')
    return
  }
  try {
    showStatus('Reading durable engagement and verifier status…')
    const session = await ensureWalletSession()
    const engagementResponse = await fetch(`${session.apiBase}/api/v2/engagements/${state.engagementId}`, { headers: { authorization: `Bearer ${session.accessToken}` } })
    const engagementPayload = await engagementResponse.json()
    if (!engagementResponse.ok) throw new Error(engagementPayload.error || `Engagement status failed (${engagementResponse.status})`)
    const engagement = engagementPayload.engagement || {}
    const paymentIntentId = state.paymentIntentId || engagement.payment_intent_id || engagement.paymentIntentId
    let intent = null
    if (paymentIntentId) {
      const intentResponse = await fetch(`${session.apiBase}/api/v2/payment-intents/${paymentIntentId}`, { headers: { authorization: `Bearer ${session.accessToken}` } })
      const intentPayload = await intentResponse.json()
      if (!intentResponse.ok) throw new Error(intentPayload.error || `Payment status failed (${intentResponse.status})`)
      intent = intentPayload.intent || intentPayload.paymentIntent || null
      state.paymentIntentId = paymentIntentId
    }
    const collaboration = engagement.collaboration_status || engagement.collaborationStatus || 'unknown'
    const payment = intent?.status || engagement.payment_status || engagement.paymentStatus || 'not_created'
    const finality = intent?.finalityStatus || intent?.finality_status || 'not_observed'
    showStatus(`Verified status: collaboration ${collaboration}; payment ${payment}; chain finality ${finality}. Only verifier evidence establishes settlement.`, 'success')
  } catch (error) {
    showStatus(`Status refresh unavailable: ${error.message}`, 'error')
  }
}

async function requestPaymentIntent() {
  const expert = experts.find((candidate) => candidate.id === state.selectedId)
  if (!expert) return

  if (!state.engagementId) {
    showStatus('Create the engagement context before requesting a payment stream.', 'error')
    return
  }

  showStatus('Connecting wallet and checking the Base Sepolia testnet…')
  try {
    const session = await ensureWalletSession()
    const response = await fetch(`${session.apiBase}/api/v2/payment-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`,
        'x-idempotency-key': `ui-${session.wallet.toLowerCase()}-${state.engagementId}-create-stream`
      },
      body: JSON.stringify({
        recipientWallet: expert.wallet,
        chainId: session.chainId,
        tokenAddress: '0x1111111111111111111111111111111111111111',
        amountBaseUnits: '12500000',
        ratePerSecondBaseUnits: '3472',
        engagementId: state.engagementId
      })
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`)
    const attachResponse = await fetch(`${session.apiBase}/api/v2/engagements/${state.engagementId}/payment-intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ paymentIntentId: payload.intent.id })
    })
    const attachPayload = await attachResponse.json()
    if (!attachResponse.ok) throw new Error(attachPayload.error || `Payment intent attachment failed (${attachResponse.status})`)
    state.paymentIntentId = payload.intent.id
    showStatus(`Intent ${payload.intent.id} is attached to the engagement. Finality is ${payload.finalityStatus}; no chain settlement has been claimed and wallet submission remains separate.`, 'success')
  } catch (error) {
    showStatus(`No payment was submitted: ${error.message}`, 'error')
  }
}

document.addEventListener('click', (event) => {
  const selectButton = event.target.closest('[data-select-id]')
  if (selectButton) selectExpert(selectButton.dataset.selectId)
  if (event.target.closest('#start-engagement')) startEngagement()
  if (event.target.closest('#request-stream')) requestPaymentIntent()
  if (event.target.closest('#refresh-payment-status')) refreshPaymentStatus()
})

document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return
  const card = event.target.closest('[data-expert-id]')
  if (!card || event.target.closest('button')) return
  event.preventDefault()
  selectExpert(card.dataset.expertId)
})
searchInput.addEventListener('input', (event) => { state.query = event.target.value; renderExperts() })
domainFilter.addEventListener('change', (event) => { state.domain = event.target.value; renderExperts() })
availabilityFilter.addEventListener('change', (event) => { state.availability = event.target.value; renderExperts() })
liveDiscoveryButton?.addEventListener('click', loadLiveDiscovery)
document.querySelector('#clear-filters').addEventListener('click', () => {
  state.query = ''; state.domain = 'all'; state.availability = 'all'
  searchInput.value = ''; domainFilter.value = 'all'; availabilityFilter.value = 'all'
  renderExperts()
})

renderExperts()
