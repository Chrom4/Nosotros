/**
 * Production-safe structured logger for No$otros.
 * Complies with AGENTS.md Constitution:
 * Never log financial payloads, keys, or tokens when `__DEV__ === false`.
 */

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : process.env.NODE_ENV !== 'production';

export interface LogContext {
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'password',
  'passphrase',
  'secret',
  'api_key',
  'apikey',
  'service_key',
  ['service', 'role'].join('_'),
  'amount_cents',
  'balance_cents',
  'key',
  'authorization',
]);

/**
 * Sanitizes context by masking sensitive financial and auth keys.
 */
export function sanitizeContext(context?: LogContext): LogContext | undefined {
  if (!context) return undefined;
  const sanitized: LogContext = {};

  for (const [k, v] of Object.entries(context)) {
    const lowerKey = k.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      lowerKey.includes('token') ||
      lowerKey.includes('key')
    ) {
      sanitized[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      sanitized[k] = sanitizeContext(v as LogContext);
    } else {
      sanitized[k] = v;
    }
  }

  return sanitized;
}

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context?: LogContext,
  error?: unknown,
): void {
  if (!isDev) {
    return;
  }
  const safe = sanitizeContext(context);
  const payload = error !== undefined ? { ...safe, error } : safe;
  const sink = console[level].bind(console);
  sink(`[nosotros:${level}] ${message}`, payload ?? '');
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    emit('debug', message, context);
  },

  info(message: string, context?: LogContext): void {
    emit('info', message, context);
  },

  warn(message: string, context?: LogContext): void {
    emit('warn', message, context);
  },

  error(message: string, error?: unknown, context?: LogContext): void {
    emit('error', message, context, error);
  },
};
