// Thin wrappers around IExecutionLogRepository writes. The repo is optional
// (tests build the orchestrator without one) and every call site already
// swallowed insert/update failures with the same log.warn — consolidated
// here so AgentOrchestrator's per-agent lifecycle doesn't repeat the
// try/catch ten times over.
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from './contract.js'
import { createLogger } from './logger.js'

const log = createLogger('execution-log')

export function safeInsertLog(
  repo: IExecutionLogRepository | undefined,
  entry: ExecutionLog,
): void {
  try {
    repo?.insert(entry)
  } catch (err) {
    log.warn({ err }, 'Failed to insert execution log')
  }
}

export function safeUpdateLog(
  repo: IExecutionLogRepository | undefined,
  id: string,
  patch: Partial<ExecutionLog>,
): void {
  try {
    repo?.update(id, patch)
  } catch (err) {
    log.warn({ err }, 'Failed to update execution log')
  }
}
