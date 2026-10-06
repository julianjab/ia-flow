/**
 * Lo que pasó en el runner, en SQLite: cada evento con lo que decidió cada pipeline (`event_log`),
 * cada span y log de cada ejecución (`execution_trace`), las conversaciones guardadas del asistente
 * (`assistant_conversation`) y las mejoras que propuso un agente (`improvement_proposal`). Es la memoria del asistente y de la
 * bandeja; OTLP (si hay endpoint) es la otra copia, para mirar a fondo en Grafana o Datadog.
 *
 * Usa el MISMO archivo que las ejecuciones (`engine.executions.path`) por una segunda conexión — en
 * WAL eso es seguro — así la bandeja cruza ejecuciones y eventos con un JOIN. Sin base de
 * ejecuciones (driver `memory`), en memoria.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DispatchJournal, DispatchRecord, DomainEvent } from '@ia-flow/agent-engine'
import {
  migrate,
  SqliteActivityReader,
  SqliteDispatchJournal,
  SqliteTraceJournal,
} from '@ia-flow/agent-engine-datasource-sqlite'
import type { TraceRecord } from '@ia-flow/telemetry'
import { trace } from '@opentelemetry/api'
import type { ConversationStore } from '../assistant/ConversationStore.js'
import type { ImprovementStore } from '../assistant/ImprovementStore.js'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { summarizeEvent } from '../inbox/eventSummary.js'
import { SqliteActivity } from '../inbox/SqliteActivity.js'
import { SqliteConversationStore } from './SqliteConversationStore.js'
import { SqliteImprovementStore } from './SqliteImprovementStore.js'

const DAY_MS = 86_400_000

export interface ActivityStore {
  activity: SqliteActivity
  /** Las conversaciones del asistente, por login de GitHub. */
  conversations: ConversationStore
  /** Las mejoras que propuso un agente, esperando a una persona. */
  improvements: ImprovementStore
  /** El journal del engine: anota y avisa. */
  dispatchJournal: DispatchJournal
  /** Anota un span o log de una ejecución, y avisa. */
  writeTrace(record: TraceRecord): void
  /** Un webhook que no llegó al engine (nadie lo escucha). */
  ignored(event: DomainEvent<any>, reason: string): void
  /** Cada evento anotado y cada registro de traza, en el momento. */
  onDispatch(listener: (entry: DispatchRecord) => void): () => void
  onTrace(listener: (record: TraceRecord) => void): () => void
  /** Borra lo que tiene más de `retentionDays` (las conversaciones, `conversationRetentionDays`;
   *  de las mejoras, sólo las ya decididas). */
  prune(): void
  close(): void
}

function databasePath(cfg: RunnerConfig): string {
  const executions = cfg.engine.executions
  // Ya resuelta por `loadRunnerConfig` (relativa a runner.yaml, o la de IA_FLOW_HOME).
  if (executions?.driver !== 'bun-sqlite' || !executions.path) return ':memory:'
  return executions.path
}

export function openActivityStore(cfg: RunnerConfig, path = databasePath(cfg)): ActivityStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL')
  migrate(database)

  const dispatchListeners = new Set<(entry: DispatchRecord) => void>()
  const traceListeners = new Set<(record: TraceRecord) => void>()
  const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of listeners) {
      try {
        listener(value)
      } catch {
        // Un listener roto (un cliente SSE que se fue) no corta la anotación.
      }
    }
  }

  const events = new SqliteDispatchJournal({
    database,
    summarize: (event) => summarizeEvent(event, cfg.inbox.commentExcerpt),
    traceId: () => trace.getActiveSpan()?.spanContext().traceId,
  })
  const traces = new SqliteTraceJournal({
    database,
    onWrite: (record) => notify(traceListeners, record),
  })

  const conversations = new SqliteConversationStore(database)
  const improvements = new SqliteImprovementStore(database)

  return {
    activity: new SqliteActivity(new SqliteActivityReader(database)),
    conversations,
    improvements,
    dispatchJournal: {
      record: (entry) => {
        events.record(entry)
        notify(dispatchListeners, entry)
      },
    },
    writeTrace: (record) => traces.write(record),
    ignored: (event, reason) => events.append({ event, reason }),
    onDispatch: (listener) => {
      dispatchListeners.add(listener)
      return () => dispatchListeners.delete(listener)
    },
    onTrace: (listener) => {
      traceListeners.add(listener)
      return () => traceListeners.delete(listener)
    },
    prune: () => {
      const cutoff = new Date(Date.now() - cfg.inbox.retentionDays * DAY_MS).toISOString()
      new SqliteActivityReader(database).prune(cutoff)
      improvements.prune(cutoff)
      conversations.prune(
        new Date(Date.now() - cfg.inbox.conversationRetentionDays * DAY_MS).toISOString(),
      )
    },
    close: () => database.close(),
  }
}
