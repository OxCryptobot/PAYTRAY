import { getAddress, isAddress } from 'ethers'

export class TokenRegistryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TokenRegistryError'
  }
}

function requireInteger(value, fieldName, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TokenRegistryError(`${fieldName} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function normalizeTokenDefinition(token) {
  if (!token || typeof token !== 'object' || Array.isArray(token)) {
    throw new TokenRegistryError('Token definition must be an object')
  }

  const chainId = requireInteger(token.chainId, 'chainId', 1, Number.MAX_SAFE_INTEGER)
  if (!isAddress(token.address)) {
    throw new TokenRegistryError('Token address must be a valid EVM address')
  }

  const decimals = requireInteger(token.decimals, 'decimals', 0, 255)
  const symbol = String(token.symbol || '').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) {
    throw new TokenRegistryError('Token symbol must contain 1-32 letters, numbers, dots, underscores, or hyphens')
  }

  const protocolContractAddress = token.protocolContractAddress == null || token.protocolContractAddress === ''
    ? null
    : token.protocolContractAddress

  if (protocolContractAddress && !isAddress(protocolContractAddress)) {
    throw new TokenRegistryError('Protocol contract address must be a valid EVM address')
  }

  return Object.freeze({
    chainId,
    address: getAddress(token.address),
    decimals,
    symbol,
    protocolContractAddress: protocolContractAddress ? getAddress(protocolContractAddress) : null,
    enabled: token.enabled !== false
  })
}

export function createTokenRegistry(tokens = []) {
  if (!Array.isArray(tokens)) {
    throw new TokenRegistryError('Token registry must be an array')
  }

  const byKey = new Map()
  for (const definition of tokens) {
    const normalized = normalizeTokenDefinition(definition)
    const key = `${normalized.chainId}:${normalized.address.toLowerCase()}`
    if (byKey.has(key)) {
      throw new TokenRegistryError(`Duplicate token registry entry: ${key}`)
    }
    byKey.set(key, normalized)
  }

  return Object.freeze({
    resolve(chainId, address) {
      if (!isAddress(address)) {
        throw new TokenRegistryError('Token address must be a valid EVM address')
      }
      const key = `${Number(chainId)}:${getAddress(address).toLowerCase()}`
      return byKey.get(key) || null
    },
    requireEnabled(chainId, address) {
      const token = this.resolve(chainId, address)
      if (!token) {
        throw new TokenRegistryError('Token is not in the Paytray registry')
      }
      if (!token.enabled) {
        throw new TokenRegistryError('Token is disabled in the Paytray registry')
      }
      return token
    },
    list({ chainId = null, enabledOnly = false } = {}) {
      return Array.from(byKey.values()).filter((token) => {
        if (chainId != null && token.chainId !== Number(chainId)) return false
        return !enabledOnly || token.enabled
      })
    },
    validateSettlementConfiguration({ chainId, protocolContractAddress, protocol = 'sablier-flow-v3' } = {}) {
      const normalizedChainId = requireInteger(chainId, 'settlement chainId', 1, Number.MAX_SAFE_INTEGER)
      if (!protocolContractAddress || !isAddress(protocolContractAddress)) {
        throw new TokenRegistryError('Settlement protocol contract address must be a valid EVM address')
      }
      const normalizedContract = getAddress(protocolContractAddress)
      const enabledTokens = this.list({ chainId: normalizedChainId, enabledOnly: true })
      if (enabledTokens.length === 0) {
        throw new TokenRegistryError(`No enabled token is configured for settlement chain ${normalizedChainId}`)
      }

      const symbols = new Set()
      for (const token of enabledTokens) {
        if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
          throw new TokenRegistryError(`Token ${token.symbol} has invalid decimals for settlement`)
        }
        if (symbols.has(token.symbol.toUpperCase())) {
          throw new TokenRegistryError(`Duplicate enabled token symbol on settlement chain: ${token.symbol}`)
        }
        symbols.add(token.symbol.toUpperCase())
        if (!token.protocolContractAddress) {
          throw new TokenRegistryError(`Token ${token.symbol} is missing its ${protocol} protocol contract address`)
        }
        if (token.protocolContractAddress !== normalizedContract) {
          throw new TokenRegistryError(`Token ${token.symbol} protocol contract does not match the configured settlement contract`)
        }
      }

      return Object.freeze({
        chainId: normalizedChainId,
        protocol,
        protocolContractAddress: normalizedContract,
        enabledTokens: enabledTokens.map((token) => ({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals
        }))
      })
    }
  })
}

export function parseTokenRegistry(value) {
  if (value == null || value === '') {
    return createTokenRegistry([])
  }

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new TokenRegistryError('Token registry must be valid JSON')
  }

  return createTokenRegistry(parsed)
}
