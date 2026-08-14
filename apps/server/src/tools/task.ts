import { applyOutcome } from '../agents/outcomes.js'
import { type PendingTask, getPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { createLogger } from '../logger.js'
// Task lifecycle tools — called via HTTP by async agents (tmux/iterm)
import { registerTool } from './index.js'

const log = createLogger('tool-task')

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
  /** @deprecated pre-structured markdown body — used only if the structured
   *  fields are absent. Mapped into `what_did` to preserve output. */
  body?: string
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
  /** @deprecated legacy field — mapped into `what_did` if `what_did` is absent. */
  summary?: string
}

interface FailTaskInput {
  task_id: string
  what_tried: string[] | string
  where_failed: string
  validations: string[] | string
  /** @deprecated legacy field — mapped into `what_tried` if `what_tried` is absent. */
  error?: string
}

registerTool({
  name: 'complete_task',
  internal: true,
  category: 'task.transition',
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
  async execute(rawInput: unknown): Promise<string> {
    const input = rawInput as CompleteTaskInput
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}' — already completed or not registered`

    // Legacy escape hatch: if a caller still sends { summary }, map it into
    // what_did so the format guarantee stays intact without breaking calls
    // from older prompts that haven't been re-seeded yet.
    if (input.what_did == null && typeof input.summary === 'string') {
      input.what_did = input.summary
    }
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

    try {
      const commentBody = formatCompleteComment(entry, input)
      await manager.postComment?.(entry.task, commentBody)

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
  category: 'task.write',
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
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    pending.task = await pending.manager.saveOutput(pending.task, input.body)
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return 'Contenido guardado correctamente.'
  },
})

// ─── add_task_comment ─────────────────────────────────────────────────────────

registerTool({
  name: 'add_task_comment',
  category: 'task.write',
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
  async execute(rawInput: unknown): Promise<string> {
    const input = rawInput as ProgressCommentInput & { task_id: string }
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.postComment) {
      throw new Error("El source de esta tarea no soporta 'postComment'")
    }

    // Legacy: prompts previos enviaban `{ body }` con markdown ya formateado.
    // Lo canalizamos como bullet único de what_did para que el encabezado
    // uniforme se aplique igual sin perder el contenido.
    if (input.what_did == null && typeof input.body === 'string') {
      input.what_did = input.body
    }

    const commentBody = formatProgressComment(pending, input)
    await pending.manager.postComment(pending.task, commentBody)
    return 'Comentario publicado.'
  },
})

// ─── set_task_field ───────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_field',
  category: 'task.write',
  description:
    'Actualiza un campo del proyecto para la tarea activa (e.g. Status, Task Type, Priority, Size, Repos). Agnóstico al source.',
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
      value: { type: 'string', description: 'Valor a asignar.' },
    },
    required: ['task_id', 'field_name', 'value'],
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setFields) {
      throw new Error("El source de esta tarea no soporta 'setFields'")
    }
    pending.task = await pending.manager.setFields(pending.task, {
      [input.field_name]: input.value,
    })
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return `Campo '${input.field_name}' actualizado a '${input.value}'.`
  },
})

// ─── set_task_labels ──────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_labels',
  category: 'task.write',
  description:
    'Aplica labels a la tarea activa. En sources sin soporte nativo de labels (local) el llamado se ignora.',
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
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setLabels) {
      throw new Error("El source de esta tarea no soporta 'setLabels'")
    }
    pending.task = await pending.manager.setLabels(pending.task, input.labels)
    return `Labels aplicados: ${input.labels.join(', ')}`
  },
})

// ─── mark_blocked_by ──────────────────────────────────────────────────────────

registerTool({
  name: 'mark_blocked_by',
  category: 'task.write',
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
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
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
  category: 'task.transition',
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
  async execute(rawInput: unknown): Promise<string> {
    const input = rawInput as FailTaskInput
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}'`

    // Legacy: older prompts still send `{ error }`. Route it into where_failed
    // so the comment renders and the failure transition still fires.
    if (input.what_tried == null) input.what_tried = []
    if (
      (input.where_failed == null || input.where_failed === '') &&
      typeof input.error === 'string'
    ) {
      input.where_failed = input.error
    }
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
      // Same story as complete_task: mutations must land on entry.task so the
      // orchestrator's post-run guard reads the current status.
      entry.task = await manager.setAgentWorking(entry.task, false)

      if (onError) {
        entry.task = await applyOutcome({ ...entry.task, error: input.error }, onError, manager)
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
      log.warn({ event: 'agent.failed', ...logCtx, error: input.error }, 'task failed via tool')
      return `Task '${entry.task.title}' marked as failed`
    } catch (err) {
      log.error({ event: 'agent.error', ...logCtx, err }, 'fail_task errored')
      throw err
    }
  },
})
