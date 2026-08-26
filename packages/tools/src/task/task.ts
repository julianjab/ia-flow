import {
  type PendingTask,
  type ResolvedPendingTask,
  applyOutcome,
  removePendingTask,
  resolvePendingTask,
} from '@ia-flow/agent-engine'
import { MULTI_VALUE_FIELD } from '@ia-flow/issue-sources'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'
// Task lifecycle tools — called via HTTP by async agents (tmux/iterm)

const log = createLogger('tool-task')

/**
 * El cierre de un run se ACEPTA siempre. Esta función decide si además hay
 * algo contra qué aplicarlo, y devuelve el mensaje final cuando no lo hay.
 *
 * Los dos casos sin nada que aplicar:
 *
 *  - **No hay run reconstruible.** Ni en memoria ni en almacenamiento
 *    durable: sin `projectId` ni `manager` no se puede comentar ni
 *    transicionar. Antes esto devolvía "No pending task" y el agente lo
 *    leía como un rechazo — se ponía a inventar explicaciones y a arreglar
 *    el issue a mano por fuera del engine. Ahora se acepta, se loguea fuerte
 *    (es un síntoma real: un run que nadie registró) y el agente termina
 *    limpio.
 *  - **Ya estaba cerrado por un tool.** No-op idempotente: ni comentario
 *    duplicado ni transición repetida.
 *
 * Devuelve `undefined` cuando SÍ hay que seguir con el cierre normal.
 */
/**
 * ¿Este cierre viene de un run que ya fue reemplazado?
 *
 * Pasa cuando el watchdog suelta una sesión que en realidad seguía viva: pasa
 * el cooldown, el daemon re-despacha la tarea, y la sesión vieja aparece con
 * su `complete_task` cuando ya hay otro agente trabajando el mismo issue. El
 * cierre se acepta igual (el trabajo se hizo), pero no puede mover la tarea
 * por debajo del run nuevo.
 *
 * La identidad viene del `?run=` de la conexión MCP, no del `task_id` que
 * escribe el modelo: es el único dato que distingue un run del siguiente.
 */
function staleRunFreeze(entry: PendingTask, ctx?: ToolContext): string | undefined {
  const callerRun = ctx?.runId
  if (!callerRun || !entry.runId) return undefined
  if (callerRun === entry.runId) return undefined
  return `este cierre viene del run ${callerRun}, pero el run vigente de la tarea es ${entry.runId}`
}

function closeWithoutRun(
  resolved: ResolvedPendingTask | undefined,
  taskId: string,
  tool: string,
): string | undefined {
  if (!resolved) {
    log.warn(
      { event: 'tool.callback.orphan', tool, taskId },
      'Cierre sin ejecución registrada — se acepta igual, pero no hay dónde aplicarlo',
    )
    return `Cierre aceptado, pero no hay ninguna ejecución registrada para '${taskId}': no se pudo comentar ni aplicar la transición. Terminá el run normalmente; queda registrado en el log del daemon.`
  }
  if (resolved.alreadyClosed) {
    log.info(
      { event: 'tool.callback.duplicate', tool, taskId },
      'Cierre repetido — el run ya estaba cerrado, no se hace nada',
    )
    return `El run de '${taskId}' ya estaba cerrado: no se repite el comentario ni la transición.`
  }
  return undefined
}

// ─── Comment formatters ──────────────────────────────────────────────────────
// The lifecycle tools (complete_task / fail_task) are internal — the engine
// wraps the agent's structured report in a consistent header so every hilo de
// tarea queda con la misma pinta:
//
//   # <agente>
//
//   **Qué hice**
//   - ...
//
//   **Validaciones**
//   - ...
//
// This runs in the tool executor (not in the prompt) so the format is
// guaranteed regardless of what the model decides to send.

function bullets(items: unknown): string {
  if (Array.isArray(items)) {
    const cleaned = items
      .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
      .filter((s) => s.length > 0)
    return cleaned.length ? cleaned.map((s) => `- ${s}`).join('\n') : '- (sin registros)'
  }
  if (typeof items === 'string' && items.trim().length) {
    return items
      .trim()
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((s) => s.length > 0)
      .map((s) => `- ${s}`)
      .join('\n')
  }
  return '- (sin registros)'
}

function formatCompleteComment(entry: PendingTask, input: CompleteTaskInput): string {
  const header = `# ${entry.agentName ?? entry.agentId ?? 'agent'}`
  const parts: string[] = [header, '', '**Qué hice**', bullets(input.what_did)]
  parts.push('', '**Validaciones**', bullets(input.validations))
  if (typeof input.notes === 'string' && input.notes.trim().length) {
    parts.push('', '**Notas**', input.notes.trim())
  }
  return parts.join('\n')
}

interface ProgressCommentInput {
  headline?: string
  what_did: string[] | string
  validations?: string[] | string
  notes?: string
}

function formatProgressComment(entry: PendingTask, input: ProgressCommentInput): string {
  const agent = entry.agentName ?? entry.agentId ?? 'agent'
  const header = input.headline ? `# ${agent} · ${input.headline}` : `# ${agent}`
  const parts: string[] = [header, '', '**Qué hice**', bullets(input.what_did)]
  if (input.validations != null) {
    parts.push('', '**Validaciones**', bullets(input.validations))
  }
  if (typeof input.notes === 'string' && input.notes.trim().length) {
    parts.push('', '**Notas**', input.notes.trim())
  }
  return parts.join('\n')
}

function formatFailComment(entry: PendingTask, input: FailTaskInput): string {
  const header = `# ${entry.agentName ?? entry.agentId ?? 'agent'} · ❌ falló`
  const parts: string[] = [header, '', '**Qué intenté**', bullets(input.what_tried)]
  parts.push('', '**Dónde falló**', (input.where_failed ?? '').trim() || '(sin detalle)')
  parts.push('', '**Validaciones corridas**', bullets(input.validations))
  return parts.join('\n')
}

interface CompleteTaskInput {
  task_id: string
  what_did: string[] | string
  validations: string[] | string
  notes?: string
  status?: string
}

interface FailTaskInput {
  task_id: string
  what_tried: string[] | string
  where_failed: string
  validations: string[] | string
}

registerTool({
  name: 'complete_task',
  internal: true,
  // Sync (anthropic-api) infers outcome from stopReason — see Agent.run —
  // and doesn't need this. Restricting to async keeps it off the sync
  // provider's tool list entirely instead of just being unused there.
  providerKinds: ['async'],
  description:
    'Cierra el run del agente. Publica un comentario estructurado en la tarea (# agente + Qué hice + Validaciones) y aplica la transición onFinish. Llámalo SIEMPRE al terminar exitosamente.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID — usa el valor de {{task.id}} del prompt.',
      },
      what_did: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Bullets con lo que hiciste: archivos tocados, PR/branch, comandos ejecutados, decisiones clave. Un ítem por bullet.',
      },
      validations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Bullets con las validaciones corridas y su resultado (bun test, biome, tsc, curl al endpoint, prueba manual, etc.).',
      },
      notes: {
        type: 'string',
        description:
          'Opcional. Contexto adicional que no encaje en Qué hice / Validaciones (riesgos, follow-ups, decisiones).',
      },
      status: {
        type: 'string',
        description:
          'Opcional. Sobrescribe la transición destino (por defecto usa el onFinish configurado).',
      },
    },
    required: ['task_id', 'what_did', 'validations'],
  },
  async execute(rawInput: unknown, ctx?: ToolContext): Promise<string> {
    const input = rawInput as CompleteTaskInput
    const resolved = await resolvePendingTask(input.task_id, ctx?.runId)
    const unlanded = closeWithoutRun(resolved, input.task_id, 'complete_task')
    if (unlanded) return unlanded
    const entry = (resolved as ResolvedPendingTask).entry

    if (input.what_did == null) input.what_did = []
    if (input.validations == null) input.validations = []

    const { manager, onFinish, broadcast, initialStatus } = entry
    const logCtx = {
      runId: entry.runId,
      agent: entry.agentId,
      projectId: entry.projectId,
      taskId: input.task_id,
    }
    log.info(
      { event: 'tool.callback.received', tool: 'complete_task', ...logCtx },
      'complete_task callback received from async session',
    )

    // Se decide ANTES de tocar nada: un cierre congelado sólo puede comentar.
    // Todo lo de abajo —bajar el flag de working, matar la sesión, sacar la
    // entrada del registry— es estado del run VIGENTE, y aplicarlo desde un
    // cierre ajeno liquida al agente que está trabajando: le mata la terminal
    // y da su run por terminado, con lo que su cierre real se descarta
    // después como duplicado.
    const frozen = resolved?.freeze ?? staleRunFreeze(entry, ctx)

    try {
      const commentBody = formatCompleteComment(entry, input)
      await manager.postComment?.(entry.task, commentBody)

      if (frozen) {
        log.warn(
          { ...logCtx, freeze: frozen },
          'Cierre aceptado sin tocar el estado de la tarea — ya lo maneja otro run',
        )
        // La fila propia sí se cierra, si se pudo identificar cuál es.
        resolved?.finalize?.('success')
        return `Cierre registrado para '${entry.task.title}', sin transición: ${frozen}`
      }

      // Write every mutation back to entry.task so the orchestrator sees the
      // post-transition state when the run returns. Skipping this made the
      // "status changed → skip default onFinish" guard read stale data and
      // clobber tool-driven moves (e.g. epic → Blocked overridden by Build).
      entry.task = await manager.setAgentWorking(entry.task, false)

      // Prefer a fresh read from the source over the in-memory `entry.task`
      // — if `setFields` was called with the source-native field name and the
      // adapter didn't normalize it, the in-memory copy still reports the
      // stale status and this guard would silently overwrite the intentional
      // move with `onFinish`. Fall back to `entry.task.status` if the source
      // doesn't expose a fresh reader.
      const freshStatus = (await manager.getCurrentStatus?.(entry.task)) ?? entry.task.status
      const statusChangedByPrompt = freshStatus.toLowerCase() !== initialStatus.toLowerCase()
      if (freshStatus !== entry.task.status) {
        entry.task = { ...entry.task, status: freshStatus }
      }
      const defaultOutcome = statusChangedByPrompt ? undefined : onFinish
      const targetOutcome = input.status ?? defaultOutcome
      if (statusChangedByPrompt && !input.status) {
        log.info(
          { ...logCtx, from: initialStatus, to: entry.task.status },
          'Task already moved by tool call — skipping default onFinish',
        )
      }
      if (targetOutcome) {
        entry.task = await applyOutcome(entry.task, targetOutcome, manager)
        broadcast({ type: 'task:updated', task: entry.task })
        log.info(
          { event: 'agent.finalize', ...logCtx, outcome: targetOutcome, status: entry.task.status },
          'Applied finish transition',
        )
      }

      try {
        await entry.killSession?.()
        log.info({ event: 'session.killed', ...logCtx }, 'Provider session closed')
      } catch (e) {
        log.warn({ ...logCtx, err: e }, 'killSession threw on complete_task')
      }
      removePendingTask(input.task_id, { finalizedByTool: true })
      // Sólo en entradas rehidratadas: el orquestador que lanzó este run ya
      // no existe, así que la fila la cierra el tool o no la cierra nadie.
      resolved?.finalize?.('success')
      log.info(
        { event: 'agent.complete', ...logCtx, outcome: targetOutcome },
        'task completed via tool',
      )
      return `Task '${entry.task.title}' completed → ${targetOutcome ?? 'no transition'}`
    } catch (err) {
      log.error({ event: 'agent.error', ...logCtx, err }, 'complete_task failed')
      throw err
    }
  },
})

// ─── update_issue_body ────────────────────────────────────────────────────────

registerTool({
  name: 'update_issue_body',
  description:
    'Guarda el resultado del análisis en el issue activo. Funciona para tareas locales y conectadas a GitHub.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      body: {
        type: 'string',
        description: 'Contenido completo en markdown. Reemplaza el body actual del issue.',
      },
    },
    required: ['task_id', 'body'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    const pending = (await resolvePendingTask(input.task_id, ctx?.runId))?.entry
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    pending.task = await pending.manager.saveOutput(pending.task, input.body)
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return 'Contenido guardado correctamente.'
  },
})

// ─── add_task_comment ─────────────────────────────────────────────────────────

registerTool({
  name: 'add_task_comment',
  description:
    'Publica un comentario de progreso en la tarea activa con el mismo formato que complete_task/fail_task (# agente + Qué hice + Validaciones). Úsalo para dejar hitos parciales durante runs largos.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      headline: {
        type: 'string',
        description:
          'Opcional. Frase corta que resume el hito (aparece en el encabezado tras el nombre del agente).',
      },
      what_did: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Bullets con lo hecho en este hito: archivos tocados, comandos, decisiones. Un ítem por bullet.',
      },
      validations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Opcional. Bullets con las validaciones corridas hasta ahora y su resultado.',
      },
      notes: {
        type: 'string',
        description: 'Opcional. Contexto adicional (riesgos, follow-ups, decisiones).',
      },
    },
    required: ['task_id', 'what_did'],
  },
  async execute(rawInput: unknown, ctx?: ToolContext): Promise<string> {
    const input = rawInput as ProgressCommentInput & { task_id: string }
    const pending = (await resolvePendingTask(input.task_id, ctx?.runId))?.entry
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.postComment) {
      throw new Error("El source de esta tarea no soporta 'postComment'")
    }

    const commentBody = formatProgressComment(pending, input)
    await pending.manager.postComment(pending.task, commentBody)
    return 'Comentario publicado.'
  },
})

// ─── set_task_field ───────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_field',
  description: [
    'Actualiza un campo del proyecto para la tarea activa (e.g. Status, Task Type, Priority, Size, Repos, Labels). Agnóstico al source.',
    'Un campo de un solo valor se asigna tal cual ("high").',
    'Un campo multi-valor (Labels) recibe operaciones con signo separadas por coma, no un valor suelto: "+añadir,-quitar" sobre lo que ya tiene, o "=exacto" para reemplazar el set completo.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      field_name: {
        type: 'string',
        description: 'Nombre del campo tal como aparece en el proyecto (e.g. "Task Type").',
      },
      value: {
        type: 'string',
        description:
          'Valor a asignar. En un campo multi-valor (Labels), tokens con signo separados por coma: "+a,-b".',
      },
    },
    required: ['task_id', 'field_name', 'value'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    const pending = (await resolvePendingTask(input.task_id, ctx?.runId))?.entry
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setFields) {
      throw new Error("El source de esta tarea no soporta 'setFields'")
    }
    const statusBefore = pending.task.status
    pending.task = await pending.manager.setFields(pending.task, {
      [input.field_name]: input.value,
    })
    // Resync the reconciliation baseline (NOT `initialStatus` — that one
    // must stay frozen for complete_task/fail_task's statusChangedByPrompt
    // check, see the field doc in pending-tasks.ts). `reconciliationStatus`
    // is what SourceIssueManager's divergence loop compares the source's
    // live status against on the next scan cycle to decide whether to
    // cancel this run — without this resync, a legitimate mid-run status
    // change made BY THIS AGENT (ie. `field_name` mapping to the source's
    // status field, e.g. a `$set:` fallback like lh116-ci-watcher forcing
    // Status) would look identical to external drift and get the run
    // cancelled out from under itself.
    //
    // Gated on BOTH (a) the status actually changing as a result of this
    // call and (b) the new value matching `input.value` — NOT an
    // unconditional resync, and not (b) alone either. `setFields` round-
    // trips to the live source, so its returned task can carry a status
    // that changed for reasons that have nothing to do with this call (the
    // user actually moved the card between dispatch and now — real drift
    // that SHOULD still cancel the run); checking (b) alone would even
    // resync on a coincidence where an unrelated field's value happens to
    // textually match the current status name (e.g. a "Sprint" field set to
    // "Blocked"). Requiring the status to have genuinely moved during THIS
    // call, to exactly the value asked for, is strong evidence this call is
    // what caused it — without needing to special-case the source-native
    // field name for status (which varies per provider).
    if (
      pending.task.status !== statusBefore &&
      pending.task.status.toLowerCase() === String(input.value).toLowerCase()
    ) {
      pending.reconciliationStatus = pending.task.status
    }
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return `Campo '${input.field_name}' actualizado a '${input.value}'.`
  },
})

// ─── set_task_labels ──────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_labels',
  // Azúcar sobre `set_task_field` con field=Labels: acepta una lista de
  // nombres y la traduce a las operaciones `+` que ese campo espera. Existe
  // porque es la forma en que los prompts ya escritos la invocan; para
  // quitar o reemplazar labels hay que usar `set_task_field`.
  description:
    'Añade labels a la tarea activa, conservando las que ya tenga. Equivale a set_task_field con field_name="Labels" y value="+label1,+label2"; para quitar o reemplazar labels usá set_task_field.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Nombres de labels a aplicar.',
      },
    },
    required: ['task_id', 'labels'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    const pending = (await resolvePendingTask(input.task_id, ctx?.runId))?.entry
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setFields) {
      throw new Error("El source de esta tarea no soporta 'setFields'")
    }
    // Aditiva por contrato (los prompts ya escritos cuentan con eso): cada
    // label se manda como un `+`, que es exactamente lo que el campo
    // multi-valor entiende — el source resuelve las ops contra lo vigente,
    // así que no hace falta leer y re-unir el set acá.
    const ops = (input.labels as string[]).map((l) => `+${l}`).join(',')
    pending.task = await pending.manager.setFields(pending.task, { [MULTI_VALUE_FIELD]: ops })
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return `Labels aplicados: ${input.labels.join(', ')}`
  },
})

// ─── mark_blocked_by ──────────────────────────────────────────────────────────

registerTool({
  name: 'mark_blocked_by',
  description:
    'Marca una relación de bloqueo entre dos issues del mismo source de la tarea activa. Útil al splitear en sub-issues: cada hijo dependiente se marca como blocked_by su(s) prerrequisito(s). GitHub: los IDs son node IDs devueltos por create_github_issue (campo issueId). Local: los IDs son task IDs; el bloqueo se persiste como una sección `## Blocked by` en el body del issue bloqueado.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'ID de la tarea activa — usar {{task.id}} del prompt. Sirve para enrutar al source correcto; los issues bloqueado/bloqueante no tienen que ser la tarea activa.',
      },
      blocked_issue_id: {
        type: 'string',
        description: 'ID del issue que quedará marcado como bloqueado (node ID en GitHub).',
      },
      blocking_issue_id: {
        type: 'string',
        description: 'ID del issue que bloquea (el prerrequisito) (node ID en GitHub).',
      },
    },
    required: ['task_id', 'blocked_issue_id', 'blocking_issue_id'],
  },
  async execute(input: any, ctx?: ToolContext): Promise<string> {
    const pending = (await resolvePendingTask(input.task_id, ctx?.runId))?.entry
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.markBlockedBy) {
      throw new Error("El source de esta tarea no soporta 'markBlockedBy'")
    }
    await pending.manager.markBlockedBy(
      pending.task,
      input.blocked_issue_id,
      input.blocking_issue_id,
    )
    return `Dependencia creada: ${input.blocked_issue_id} blocked by ${input.blocking_issue_id}`
  },
})

registerTool({
  name: 'fail_task',
  internal: true,
  // Unlike complete_task, sync DOES need this: Agent.run can infer *success*
  // from a plain end_turn (no explicit signal needed — see the Stop-hook
  // comment-post in Agent.ts), but it can't infer an intentional *failure*
  // the same way — stopReason alone can't tell "I finished successfully"
  // apart from "I'm giving up, here's why" for a sync agent that must decide
  // that itself (e.g. subscriptions-ci-watcher on a red CI check). Available
  // to both kinds; async keeps using it as its only way to end a run at all.
  providerKinds: ['sync', 'async'],
  description:
    'Marca el run del agente como fallido. Publica un comentario estructurado (# agente ❌ + Qué intenté + Dónde falló + Validaciones) y aplica la transición onError.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID — usa el valor de {{task.id}} del prompt.',
      },
      what_tried: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bullets con lo que intentaste antes de rendirte.',
      },
      where_failed: {
        type: 'string',
        description:
          'Descripción concreta del punto de fallo (mensaje de error, comando, archivo).',
      },
      validations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bullets con las validaciones que sí corriste y su resultado.',
      },
    },
    required: ['task_id', 'what_tried', 'where_failed'],
  },
  async execute(rawInput: unknown, ctx?: ToolContext): Promise<string> {
    const input = rawInput as FailTaskInput
    const resolved = await resolvePendingTask(input.task_id, ctx?.runId)
    const unlanded = closeWithoutRun(resolved, input.task_id, 'fail_task')
    if (unlanded) return unlanded
    const entry = (resolved as ResolvedPendingTask).entry

    if (input.what_tried == null) input.what_tried = []
    if (input.validations == null) input.validations = []

    const { manager, onError, broadcast } = entry
    const logCtx = {
      runId: entry.runId,
      agent: entry.agentId,
      projectId: entry.projectId,
      taskId: input.task_id,
    }
    log.info(
      { event: 'tool.callback.received', tool: 'fail_task', ...logCtx },
      'fail_task callback received from async session',
    )

    // Mismo criterio que complete_task: congelado = sólo comentar. Ver el
    // comentario de allá arriba.
    const frozen = resolved?.freeze ?? staleRunFreeze(entry, ctx)

    try {
      const commentBody = formatFailComment(entry, input)
      // Publish on both channels so:
      //  - `postComment` deja el fallo en el mismo timeline visible que los
      //    éxitos (uniforme, buscable).
      //  - `postError` mantiene el estado de error en el source: en GitHub es
      //    un banner ⚠️; en local persiste `task.error` para el banner rojo
      //    de la UI. Sin esto el fallo pasaba desapercibido en local salvo
      //    que abrieras el hilo de comentarios.
      if (manager.postComment) {
        await manager.postComment(entry.task, commentBody)
      }
      await manager.postError?.(entry.task, (input.where_failed ?? '').trim() || commentBody)

      if (frozen) {
        log.warn(
          { ...logCtx, freeze: frozen },
          'Fallo registrado sin tocar el estado de la tarea — ya lo maneja otro run',
        )
        resolved?.finalize?.('error')
        return `Fallo registrado para '${entry.task.title}', sin transición: ${frozen}`
      }

      // Same story as complete_task: mutations must land on entry.task so the
      // orchestrator's post-run guard reads the current status.
      entry.task = await manager.setAgentWorking(entry.task, false)

      if (onError) {
        entry.task = await applyOutcome(
          { ...entry.task, error: input.where_failed },
          onError,
          manager,
        )
        broadcast({ type: 'task:updated', task: entry.task })
        log.info(
          { event: 'agent.finalize', ...logCtx, outcome: onError, status: entry.task.status },
          'Applied error transition',
        )
      }

      try {
        await entry.killSession?.()
        log.info({ event: 'session.killed', ...logCtx }, 'Provider session closed')
      } catch (e) {
        log.warn({ ...logCtx, err: e }, 'killSession threw on fail_task')
      }
      removePendingTask(input.task_id, { finalizedByTool: true })
      // Ver el mismo llamado en complete_task: en un run rehidratado no queda
      // nadie más que escriba el resultado en la fila.
      resolved?.finalize?.('error')
      log.warn(
        { event: 'agent.failed', ...logCtx, error: input.where_failed },
        'task failed via tool',
      )
      return `Task '${entry.task.title}' marked as failed`
    } catch (err) {
      log.error({ event: 'agent.error', ...logCtx, err }, 'fail_task errored')
      throw err
    }
  },
})
