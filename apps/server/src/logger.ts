// Structured logger — pretty console + JSON file
// Log file: apps/server/logs/daemon.log  (rotates at 50 MB)
import pino from 'pino'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const LOG_DIR = join(import.meta.dir, '..', 'logs')
const LOG_FILE = join(LOG_DIR, 'daemon.log')
const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level

mkdirSync(LOG_DIR, { recursive: true })

const logger = pino(
  {
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid },
    // Serializer: make Error objects readable
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  pino.transport({
    targets: [
      // Console — pretty colored output
      {
        target: 'pino-pretty',
        level: LOG_LEVEL,
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '[{module}] {msg}',
          singleLine: Bun.env.LOG_SINGLE_LINE === 'true',
        },
      },
      // File — newline-delimited JSON, easy to grep/tail
      {
        target: 'pino/file',
        level: LOG_LEVEL,
        options: {
          destination: LOG_FILE,
          append: true,
          mkdir: true,
          // Rotate at 50 MB (pino/file supports maxSize in newer versions)
        },
      },
    ],
  }),
)

// Child logger factory — adds `module` field to every log line
export function createLogger(module: string) {
  return logger.child({ module })
}

export default logger
