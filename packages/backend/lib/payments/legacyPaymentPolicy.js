import { AuthorizationError } from '../errors.js'

export function assertLegacyPaymentMutationAllowed({ isProd }) {
  if (isProd) {
    throw new AuthorizationError('Legacy in-memory payment mutations are disabled in production; use durable v2 payment APIs')
  }

  return true
}
