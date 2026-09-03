export function buildEngagementThreadProjection({ engagement, clientWallet, providerWallet, now = () => new Date().toISOString() }) {
  const threadId = String(engagement?.thread_id || '')
  if (!threadId) return null

  return {
    id: threadId,
    engagementId: String(engagement.id),
    sessionId: engagement.match_session_id ? String(engagement.match_session_id) : null,
    participants: [String(clientWallet).toLowerCase(), String(providerWallet).toLowerCase()],
    context: {
      objective: String(engagement.scope || 'collaboration engagement'),
      proposedTerms: engagement.proposed_terms || {},
      discoveryContext: engagement.discovery_context || {}
    },
    messages: [],
    status: String(engagement.collaboration_status || 'ready'),
    createdAt: engagement.created_at || now()
  }
}
