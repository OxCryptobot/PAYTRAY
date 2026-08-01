import config from './config.js'

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
}

class Logger {
  constructor(context = 'PayTray') {
    this.context = context
    this.level = config.logging.level.toLowerCase()
  }

  shouldLog(level) {
    return levels[level] <= levels[this.level]
  }

  write(level, message, data = null) {
    if (!this.shouldLog(level)) {
      return
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      context: this.context,
      message,
      ...(data ? { data } : {})
    }

    console[level === 'debug' ? 'log' : level](JSON.stringify(payload))
  }

  error(message, error = null, context = null) {
    this.write('error', message, error ? { error: error.message, ...(context ? { context } : {}) } : context)
  }

  warn(message, data = null) {
    this.write('warn', message, data)
  }

  info(message, data = null) {
    this.write('info', message, data)
  }

  debug(message, data = null) {
    this.write('debug', message, data)
  }

  audit(action, userId, details = null) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'AUDIT',
      context: this.context,
      action,
      userId,
      ...(details ? { details } : {})
    }))
  }
}

let loggerInstance = null

export function getLogger(context = 'PayTray') {
  if (!loggerInstance || loggerInstance.context !== context) {
    loggerInstance = new Logger(context)
  }
  return loggerInstance
}

export function createLogger(context) {
  return new Logger(context)
}

export function requestLogger(req, res, next) {
  const logger = getLogger('HTTP')
  const startedAt = Date.now()
  const originalEnd = res.end

  res.end = function (...args) {
    logger.info('HTTP request', {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    })
    return originalEnd.apply(this, args)
  }

  next()
}

export function errorLogger(err, req, res, next) {
  getLogger('ErrorHandler').error(`${req.method} ${req.url}`, err)
  next(err)
}

export default {
  Logger,
  getLogger,
  createLogger,
  requestLogger,
  errorLogger
}
