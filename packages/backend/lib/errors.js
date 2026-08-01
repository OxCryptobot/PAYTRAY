export class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.details = details
    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      error: this.message,
      statusCode: this.statusCode,
      ...(this.details ? { details: this.details } : {})
    }
  }
}

export class ValidationError extends AppError {
  constructor(message, fields = null) {
    super(message, 400, fields)
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401)
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409)
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter = 60) {
    super(message, 429, { retryAfter })
    this.retryAfter = retryAfter
  }
}

export class ExternalServiceError extends AppError {
  constructor(service, message) {
    super(`${service} service error: ${message}`, 502)
    this.service = service
  }
}

export const schemas = {
  wallet: {
    address(value) {
      if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new ValidationError('Invalid wallet address')
      }
      return value.toLowerCase()
    },
    signature(value) {
      if (typeof value !== 'string' || !/^0x[a-fA-F0-9]+$/.test(value)) {
        throw new ValidationError('Invalid signature')
      }
      return value
    }
  },
  user: {
    name(value) {
      if (typeof value !== 'string' || value.trim().length < 2) {
        throw new ValidationError('Name is required')
      }
      return value.trim()
    },
    bio(value) {
      if (value == null) {
        return null
      }
      if (typeof value !== 'string' || value.length > 1000) {
        throw new ValidationError('Bio must be a string up to 1000 characters')
      }
      return value.trim()
    },
    hourlyRate(value) {
      if (value == null || value === '') {
        return null
      }
      const rate = Number(value)
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new ValidationError('Hourly rate must be a positive number')
      }
      return rate
    },
    expertise(value) {
      if (!Array.isArray(value)) {
        throw new ValidationError('Expertise must be an array')
      }
      return value.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
          throw new ValidationError('Expertise items must be non-empty strings')
        }
        return item.trim()
      })
    }
  },
  payment: {
    amount(value) {
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError('Amount must be a positive number')
      }
      return amount
    },
    token(value) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new ValidationError('Token is required')
      }
      return value.toUpperCase()
    },
    duration(value) {
      const duration = Number.parseInt(value, 10)
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new ValidationError('Duration must be a positive integer')
      }
      return duration
    }
  },
  livekit: {
    roomName(value) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,255}$/.test(value)) {
        throw new ValidationError('Invalid room name')
      }
      return value
    },
    username(value) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new ValidationError('Username is required')
      }
      return value.trim()
    }
  }
}

export function validate(schema, data) {
  const result = { ...data }
  const errors = {}

  for (const [key, validator] of Object.entries(schema)) {
    try {
      result[key] = validator(result[key])
    } catch (error) {
      errors[key] = error.message
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Validation failed', errors)
  }

  return result
}

export default {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ExternalServiceError,
  schemas,
  validate
}
