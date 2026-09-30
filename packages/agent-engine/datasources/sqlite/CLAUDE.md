# @ia-flow/agent-engine-datasource-sqlite

`ExecutionRepository` de `@ia-flow/agent-engine` sobre SQLite: las ejecuciones pausadas
sobreviven a un reinicio. El repositorio depende de un puerto (`SqliteDatabase`), no de un
runtime: `./node` abre la base con `node:sqlite` (Node ≥ 22.13); en Bun, la app le pasa un
`Database` de `bun:sqlite`. Hace I/O (una base en disco): por eso vive
fuera del core.

## Estructura

```
src/
├── SqliteDatabase.ts             el puerto: la base síncrona que comparten node:sqlite y bun:sqlite
├── SqliteExecutionRepository.ts  el repositorio: save / delivered / read / live / unread
├── SqliteExecutionStore.ts       ExecutionStore sobre ese repositorio (+ close)
├── SqliteDispatchJournal.ts      `event_log`: el DispatchJournal del Engine + `append` (lo que la app ignora)
├── SqliteTraceJournal.ts         `execution_trace`: el TraceJournal de `traceRecorder` (+ `onWrite`)
├── SqliteActivityReader.ts       el lado de lectura: eventos, traza, ejecuciones por task, usage, agentOutcome, prune
├── node.ts                       entry `./node`: openNodeSqlite + `sqliteStoreDriver` (un store sobre node:sqlite)
├── migrations.ts                 el esquema por versión (PRAGMA user_version)
└── tests/                        el contrato del store + reinicios reales sobre un archivo
```

## Reglas que no son obvias

- **El entry principal no importa `node:sqlite`**: carga en cualquier runtime. Lo de Node vive en
  `./node`.
- **Síncrono a propósito** (`DatabaseSync` / `bun:sqlite`): el store ocupa una task en el mismo tick del
  `start`; una escritura asíncrona abriría una ventana en la que otra corrida la vería libre.
- **Un proceso por base.** La exclusión por task y el tope viven en memoria (el
  `ExecutionScheduler` del core). Varias réplicas sobre la misma base necesitarían leases.
- **Al arrancar**, el store recupera lo vivo: pausadas → vuelven a esperar; las que corrían con
  progreso en `checkpoint_json` (la conversación de un agente, en `state`) → se retoman desde ahí;
  las demás → `failed` con `close_reason = 'interrupted'`, y lo que no leyeron sale una sola vez por
  `takeOrphaned()` (el `Engine` lo re-despacha).
- **Migraciones**: una nueva se AGREGA al final de `MIGRATIONS`; nunca se edita una que ya corrió.
- **Ids**: UUID (los genera el `ExecutionStore`). La tabla `counters` de la migración 1 quedó
  sin uso: una migración no se edita.
- **La actividad** (migración 2): una fila por evento en `event_log` (por `id`; un re-despacho con
  el mismo id la pisa con lo último), y la traza de cada ejecución en `execution_trace` (`seq` da
  el orden). `task_ref`/`project_id`/`delivery_id` salen del `scope` (`issue`, `projectId`,
  `deliveryId`). El payload se guarda sólo si `keepPayload` (default: los derivados). El reader
  filtra las ejecuciones por task con JSON1 sobre la `key` (pares `[clave, valor]` de
  `scopeExecutionKey`); una key que no es JSON no rompe la consulta, sólo no matchea. `agentOutcome`
  lee el último span `ia.step.kind = agent` (las tools heredan `ia.agent.id`: no alcanza con eso).
- `node:sqlite` imprime un `ExperimentalWarning` al cargarse.

## Antes de commitear

```bash
bun run --filter @ia-flow/agent-engine-datasource-sqlite typecheck
bun run --filter @ia-flow/agent-engine-datasource-sqlite test
```
