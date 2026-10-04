import { config } from '../config'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const
type Level = keyof typeof LEVELS

const threshold = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : 'info']

function write(level: Exclude<Level, 'silent'>, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...meta })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta)
}

export function errorMeta(error: unknown) {
  if (error instanceof Error) return { error: error.message, stack: error.stack }
  return { error: String(error) }
}
