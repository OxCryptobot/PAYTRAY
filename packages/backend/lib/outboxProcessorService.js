import { projectExtensionPayload } from './extensionContracts.js'
import { assertSafeWebhookUrl, validateWebhookUrl } from './webhookSecurity.js'
import { assertTimestampFresh, createWebhookSignatureHeader } from './webhookSignature.js'
import {
  claimOutboxEvents,
  listDueOutboxEvents,
  markOutboxProcessed,
  recordOutboxFailure
} from './outboxDeliveryService.js'

function boundedString(value, maximum = 500) {
  return String(value || '').slice(0, maximum)
}

function createDispatchEnvelope({ hook, event, payload, signingSecret, eventId = null, timestamp = String(Date.now()), signatureToleranceMs = 300000, nowMs = Date.now() }) {
  if (signingSecret) assertTimestampFresh(Number(timestamp), { nowMs, toleranceMs: signatureToleranceMs })
  const projectedPayload = hook.apiVersion === 'v2'
    ? projectExtensionPayload({ hook, payload, eventId: eventId || undefined, occurredAt: new Date(Number(timestamp)).toISOString() })
    : payload
  const body = JSON.stringify({ event, payload: projectedPayload })
  const signature = signingSecret
    ? createWebhookSignatureHeader({ timestamp, body, secret: signingSecret })
    : null
  return { body, timestamp: String(timestamp), signature }
}

function matchingHooks(hooks, eventType) {
  return hooks.filter((hook) => hook && hook.apiVersion === 'v2' && hook.event === eventType)
}

function safeDeliveryResult({ event, hook, status, error = null, signatureProvided = false }) {
  return {
    eventId: event.id,
    eventType: event.eventType,
    hookId: hook?.id || null,
    callbackUrl: hook?.callbackUrl || null,
    status,
    error: error ? boundedString(error.message || error) : null,
    payloadSha256: event.payloadSha256,
    payloadKeys: event.payloadKeys,
    signatureProvided,
    settlementAuthority: false,
    mutation: 'read_only'
  }
}

async function deliverToHook({ event, hook, signingSecret, timeoutMs, signatureToleranceMs, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required for outbox delivery')
  const callbackUrl = await assertSafeWebhookUrl(hook.callbackUrl)
  const envelope = createDispatchEnvelope({
    hook,
    event: hook.event,
    payload: event.payload,
    signingSecret,
    eventId: `${event.id}:${hook.id}`,
    signatureToleranceMs
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {
      'content-type': 'application/json',
      'x-paytray-timestamp': envelope.timestamp
    }
    if (envelope.signature) headers['x-paytray-signature'] = envelope.signature
    const response = await fetchImpl(callbackUrl, {
      method: 'POST',
      headers,
      body: envelope.body,
      signal: controller.signal
    })
    if (!response?.ok) throw new Error(`webhook_http_${response?.status || 'unknown'}`)
    return safeDeliveryResult({ event, hook, status: 'delivered', signatureProvided: Boolean(envelope.signature) })
  } finally {
    clearTimeout(timeout)
  }
}

function dryRunHookResult({ event, hook, signingSecret, signatureToleranceMs }) {
  try {
    validateWebhookUrl(hook.callbackUrl)
    const envelope = createDispatchEnvelope({
      hook,
      event: hook.event,
      payload: event.payload,
      signingSecret,
      eventId: `${event.id}:${hook.id}`,
      signatureToleranceMs,
      timestamp: String(Date.now())
    })
    return safeDeliveryResult({ event, hook, status: 'would_deliver', signatureProvided: Boolean(envelope.signature) })
  } catch (error) {
    return safeDeliveryResult({ event, hook, status: 'blocked', error, signatureProvided: Boolean(signingSecret) })
  }
}

export async function processDurableOutbox({
  client,
  hooks = [],
  dryRun = true,
  limit = 25,
  leaseMs = 120000,
  maxAttempts = 5,
  retryBaseDelayMs = 1000,
  timeoutMs = 2500,
  signingSecret = null,
  signatureToleranceMs = 300000,
  fetchImpl = globalThis.fetch
}) {
  const events = dryRun
    ? await listDueOutboxEvents({ client, limit, maxAttempts })
    : await claimOutboxEvents({ client, limit, leaseMs, maxAttempts })
  const results = []
  let processed = 0
  let failed = 0
  let skipped = 0

  for (const event of events) {
    const subscribers = matchingHooks(hooks, event.eventType)
    if (subscribers.length === 0) {
      if (!dryRun) await markOutboxProcessed({ client, eventId: event.id, leaseToken: event.leaseToken })
      skipped += 1
      results.push({
        eventId: event.id,
        eventType: event.eventType,
        status: dryRun ? 'would_skip_no_subscriber' : 'processed_no_subscriber',
        matchedHooks: 0,
        payloadSha256: event.payloadSha256,
        payloadKeys: event.payloadKeys,
        settlementAuthority: false,
        mutation: dryRun ? 'read_only' : 'outbox_delivery_only'
      })
      processed += 1
      continue
    }

    if (dryRun) {
      const hookResults = subscribers.map((hook) => dryRunHookResult({ event, hook, signingSecret, signatureToleranceMs }))
      const blocked = hookResults.some((item) => item.status === 'blocked')
      if (blocked) failed += 1
      else processed += 1
      results.push({
        eventId: event.id,
        eventType: event.eventType,
        status: blocked ? 'blocked' : 'would_deliver',
        matchedHooks: subscribers.length,
        deliveries: hookResults,
        payloadSha256: event.payloadSha256,
        payloadKeys: event.payloadKeys,
        settlementAuthority: false,
        mutation: 'read_only'
      })
      continue
    }

    const deliveries = []
    let eventError = null
    for (const hook of subscribers) {
      try {
        deliveries.push(await deliverToHook({ event, hook, signingSecret, timeoutMs, signatureToleranceMs, fetchImpl }))
      } catch (error) {
        eventError = eventError || error
        deliveries.push(safeDeliveryResult({ event, hook, status: 'failed', error, signatureProvided: Boolean(signingSecret) }))
      }
    }

    if (eventError) {
      const failedEvent = await recordOutboxFailure({ client, eventId: event.id, leaseToken: event.leaseToken, error: eventError, retryBaseDelayMs, maxAttempts })
      failed += 1
      results.push({
        eventId: event.id,
        eventType: event.eventType,
        status: failedEvent?.status || 'failed',
        deliveries,
        lastError: failedEvent?.lastError || boundedString(eventError.message),
        payloadSha256: event.payloadSha256,
        payloadKeys: event.payloadKeys,
        settlementAuthority: false,
        mutation: 'outbox_delivery_only'
      })
    } else {
      await markOutboxProcessed({ client, eventId: event.id, leaseToken: event.leaseToken })
      processed += 1
      results.push({
        eventId: event.id,
        eventType: event.eventType,
        status: 'processed',
        deliveries,
        payloadSha256: event.payloadSha256,
        payloadKeys: event.payloadKeys,
        settlementAuthority: false,
        mutation: 'outbox_delivery_only'
      })
    }
  }

  return {
    status: failed > 0 ? 'attention' : 'ok',
    dryRun,
    claimed: dryRun ? 0 : events.length,
    candidates: events.length,
    processed,
    failed,
    skipped,
    results,
    deliverySemantics: 'at_least_once_bounded_retry',
    authority: 'durable_outbox_delivery',
    settlementAuthority: false,
    mutation: dryRun ? 'read_only' : 'outbox_delivery_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { createDispatchEnvelope, matchingHooks }
