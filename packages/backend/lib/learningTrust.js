// Receipt inclusion alone does not establish that a payment matches a stream.
export const LEARNING_TRUST_POLICY = 'settlement-unverified-v1'

export function migrateLearningTrust(snapshot) {
  if (!snapshot || snapshot.learningTrustPolicy === LEARNING_TRUST_POLICY) return snapshot

  return {
    ...snapshot,
    learningTrustPolicy: LEARNING_TRUST_POLICY,
    learner: null,
    riskLearner: null,
    selfReview: null,
    reputationEvents: Array.isArray(snapshot.reputationEvents)
      ? snapshot.reputationEvents.map((event) => event.trusted
        ? { ...event, trusted: false, trustReason: 'settlement_details_unverified' }
        : event)
      : snapshot.reputationEvents,
    paymentStreams: Array.isArray(snapshot.paymentStreams)
      ? snapshot.paymentStreams.map(([id, stream]) => [id, { ...stream, riskLearned: false }])
      : snapshot.paymentStreams
  }
}
