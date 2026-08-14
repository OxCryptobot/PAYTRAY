export const config = {
  env: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production',
  server: {
    host: process.env.HOST || '0.0.0.0',
    port: Number.parseInt(process.env.PORT || '3001', 10)
  },
  database: {
    url: process.env.DATABASE_URL || null,
    pool: {
      min: Number.parseInt(process.env.DB_POOL_MIN || '1', 10),
      max: Number.parseInt(process.env.DB_POOL_MAX || '5', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    }
  },
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || null,
    apiSecret: process.env.LIVEKIT_API_SECRET || null,
    url: process.env.LIVEKIT_URL || 'http://localhost:7880',
    tokenTTL: Number.parseInt(process.env.LIVEKIT_TOKEN_TTL || '86400', 10)
  },
  jwt: {
    secret: process.env.JWT_SECRET || null,
    accessTokenTTL: process.env.JWT_ACCESS_TTL || '15m',
    refreshTokenTTL: process.env.JWT_REFRESH_TTL || '7d'
  },
  auth: {
    adminWallets: (process.env.ADMIN_WALLETS || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    operatorWallets: (process.env.OPERATOR_WALLETS || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    challengeTTLSeconds: Number.parseInt(process.env.AUTH_CHALLENGE_TTL_SECONDS || '300', 10),
    loginAttemptLimit: Number.parseInt(process.env.AUTH_LOGIN_ATTEMPT_LIMIT || '20', 10),
    walletVerifyChallengeTTLSeconds: Number.parseInt(process.env.WALLET_VERIFY_CHALLENGE_TTL_SECONDS || '300', 10),
    walletVerifyAttemptLimit: Number.parseInt(process.env.WALLET_VERIFY_ATTEMPT_LIMIT || '20', 10)
  },
  cors: {
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(','),
    credentials: true
  },
  rateLimit: {
    windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
    max: Number.parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    tokenGenLimit: Number.parseInt(process.env.TOKEN_GEN_LIMIT || '10', 10)
  },
  payments: {
    settlementChainId: Number.parseInt(process.env.SETTLEMENT_CHAIN_ID || '84532', 10),
    protocol: process.env.PAYMENT_STREAM_PROTOCOL || 'sablier-flow-v3',
    protocolContractAddress: process.env.PAYMENT_STREAM_PROTOCOL_CONTRACT || null,
    rpcUrl: process.env.PAYMENT_RPC_URL || null,
    mainnetEnabled: process.env.PAYMENT_MAINNET_ENABLED === 'true',
    tokenRegistry: process.env.PAYMENT_TOKEN_REGISTRY || '[]',
    finalityConfirmations: Number.parseInt(process.env.PAYMENT_FINALITY_CONFIRMATIONS || '10', 10),
    allowLegacyConfirmations: process.env.NODE_ENV !== 'production' && process.env.ALLOW_LEGACY_PAYMENT_CONFIRMATIONS !== 'false',
    reliabilityTargetPct: Number.parseInt(process.env.RELIABILITY_TARGET_PCT || '99', 10),
    reliabilityMinSamples: Number.parseInt(process.env.RELIABILITY_MIN_SAMPLES || '3', 10)
  },
  publicApi: {
    key: process.env.PUBLIC_API_KEY || null
  },
  state: {
    filePath: process.env.STATE_FILE_PATH || '.data/runtime-state.json',
    flushIntervalMs: Number.parseInt(process.env.STATE_FLUSH_INTERVAL_MS || '5000', 10)
  },
  webhooks: {
    timeoutMs: Number.parseInt(process.env.WEBHOOK_TIMEOUT_MS || '2500', 10),
    maxAttempts: Number.parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '3', 10),
    retryBaseDelayMs: Number.parseInt(process.env.WEBHOOK_RETRY_BASE_DELAY_MS || '1000', 10),
    signingSecret: process.env.WEBHOOK_SIGNING_SECRET || null
  },
  observability: {
    availabilityTargetPct: Number.parseInt(process.env.SLO_AVAILABILITY_TARGET || '99', 10),
    p95LatencyTargetMs: Number.parseInt(process.env.SLO_P95_LATENCY_TARGET_MS || '800', 10)
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json'
  }
}

export function validateConfig() {
  const errors = []

  if (!config.jwt.secret) {
    if (config.isProd) {
      errors.push('JWT_SECRET is required in production')
    } else {
      config.jwt.secret = 'dev-secret-key-minimum-32-characters-long'
    }
  }

  if (config.isProd && !config.database.url) {
    errors.push('DATABASE_URL is required in production')
  }

  if (!Number.isInteger(config.payments.finalityConfirmations) || config.payments.finalityConfirmations < 1) {
    errors.push('PAYMENT_FINALITY_CONFIRMATIONS must be a positive integer')
  }

  if (config.isProd && config.payments.allowLegacyConfirmations) {
    errors.push('ALLOW_LEGACY_PAYMENT_CONFIRMATIONS cannot be enabled in production')
  }

  if (config.payments.mainnetEnabled && !config.isProd) {
    errors.push('PAYMENT_MAINNET_ENABLED can only be enabled in production')
  }

  if (config.payments.mainnetEnabled && config.payments.settlementChainId !== 8453) {
    errors.push('PAYMENT_MAINNET_ENABLED requires Base mainnet chain ID 8453')
  }

  if (config.payments.settlementChainId === 8453 && !config.payments.mainnetEnabled) {
    errors.push('Base mainnet settlement requires PAYMENT_MAINNET_ENABLED=true in production')
  }

  if (!config.payments.mainnetEnabled && config.payments.settlementChainId !== 84532) {
    errors.push('Non-mainnet PayTray settlement must use Base Sepolia chain ID 84532')
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }

  return true
}

export default config
