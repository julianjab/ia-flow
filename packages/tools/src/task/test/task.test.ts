import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  setPendingTaskRehydrator,
} from '@ia-flow/agent-engine'
import { type TaskSource, mergeSourceFieldsIntoTask } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { getTool } from '../../engine.js'

import '../task.js'

// ─── Fake manager captures port calls ─────────────────────────────────────────

interface FakeCalls {
  saveOutput: Array<{ task: Task; content: string }>
  postComment: Array<{ task: Task; body: string }>
  postError: Array<{ task: Task; error: string; alreadyCommented?: boolean }>
  setFields: Array<{ task: Task; fields: Record<string, string> }>
  setLabels: Array<{ task: Task; labels: string[] }>
  applyTransition: Array<{ task: Task; status: string }>
  transferToRepo: Array<{ task: Task; targetRepo: string }>
}

function makeFakeManager(calls: FakeCalls): TaskSource {
  return {
    async applyTransition(task, status) {
      calls.applyTransition.push({ task, status })
      return { ...task, status }
    },
    async saveOutput(task, content) {
      calls.saveOutput.push({ task, content })
      return { ...task, description: content }
    },
    async setAgentWorking(task) {
      return task
    },
    async postComment(task, body) {
      calls.postComment.push({ task, body })
    },
    async postError(task, error, opts) {
      calls.postError.push({ task, error, alreadyCommented: opts?.alreadyCommented })
    },
    async setFields(task, fields) {
      calls.setFields.push({ task, fields })
      return mergeSourceFieldsIntoTask(task, fields)
    },
    async setLabels(task, labels) {
      calls.setLabels.push({ task, labels })
      return task
    },
    async getCurrentStatus(task) {
      return task.status
    },
    async transferToRepo(task, targetRepo) {
      calls.transferToRepo.push({ task, targetRepo })
      return {
        repo: targetRepo,
        issueNumber: 4321,
        issueUrl: `https://github.com/acme/${targetRepo}/issues/4321`,
      }
    },
  }
}

const TASK_ID = 'task-under-test'

function baseTask(): Task {
  return {
    id: TASK_ID,
    title: 'Sample',
    description: 'orig',
    status: 'Queue',
    type: 'functional',
    repos: [],
    created_at: '2025-01-01T00:00:00Z',
  }
}

let calls: FakeCalls
let broadcasts: object[]

beforeEach(() => {
  calls = {
    saveOutput: [],
    postComment: [],
    postError: [],
    setFields: [],
    setLabels: [],
    applyTransition: [],
    transferToRepo: [],
  }
  broadcasts = []
  registerPendingTask(TASK_ID, {
    task: baseTask(),
    manager: makeFakeManager(calls),
    broadcast: (msg) => broadcasts.push(msg),
    initialStatus: 'Queue',
    exits: { success: 'Done' },
  })
})

afterEach(() => {
  removePendingTask(TASK_ID)
})

describe('agnostic task tools route via ITaskSource', () => {
  it('update_issue_body → manager.saveOutput', async () => {
    const tool = getTool('update_issue_body')!
    await tool.execute({ task_id: TASK_ID, body: 'new content' }, { repoPaths: {} })
    expect(calls.saveOutput).toHaveLength(1)
    expect(calls.saveOutput[0].content).toBe('new content')
    expect(broadcasts).toHaveLength(1)
  })

  it('add_task_comment renders structured markdown via manager.postComment', async () => {
    const tool = getTool('add_task_comment')!
    await tool.execute(
      {
        task_id: TASK_ID,
        headline: 'checkpoint',
        what_did: ['tocó A', 'tocó B'],
        validations: ['bun test ok'],
      },
      { repoPaths: {} },
    )
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toMatch(/^# .+· checkpoint$/m)
    expect(body).toContain('**Qué hice**')
    expect(body).toContain('- tocó A')
    expect(body).toContain('**Validaciones**')
  })

  it('set_task_field → manager.setFields with a single-entry object', async () => {
    const tool = getTool('set_task_field')!
    await tool.execute(
      { task_id: TASK_ID, field_name: 'Task Type', value: 'Functional' },
      { repoPaths: {} },
    )
    expect(calls.setFields).toHaveLength(1)
    expect(calls.setFields[0].fields).toEqual({ 'Task Type': 'Functional' })
  })

  it('set_task_field resyncs reconciliationStatus when field_name targets status', async () => {
    const tool = getTool('set_task_field')!
    await tool.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    expect(getPendingTask(TASK_ID)?.reconciliationStatus).toBe('Blocked')
  })

  it('set_task_field does NOT resync when an unrelated field value coincidentally matches the current status', async () => {
    // The gate can't rely on "value matches status" alone — a field like
    // Sprint could legitimately be set to a value that happens to read the
    // same as the task's current status text. baseTask().status is 'Queue';
    // setting an unrelated field to that same string must not be read as
    // "this call moved the status".
    const tool = getTool('set_task_field')!
    await tool.execute(
      { task_id: TASK_ID, field_name: 'Sprint', value: 'Queue' },
      { repoPaths: {} },
    )
    expect(getPendingTask(TASK_ID)?.reconciliationStatus).toBeUndefined()
  })

  it('set_task_field does NOT resync reconciliationStatus for an unrelated field', async () => {
    // Guards against masking real external drift: if the card genuinely
    // moved between dispatch and now, an unrelated field write (Priority,
    // Task Type, ...) must not silently absorb that drift into the
    // reconciliation baseline — see the gate comment in task.ts.
    const tool = getTool('set_task_field')!
    await tool.execute(
      { task_id: TASK_ID, field_name: 'Task Type', value: 'Functional' },
      { repoPaths: {} },
    )
    expect(getPendingTask(TASK_ID)?.reconciliationStatus).toBeUndefined()
  })

  it('set_task_labels → manager.setFields con el campo multi-valor en modo añadir', async () => {
    // La tool es aditiva por contrato: cada label viaja como un `+`, y es el
    // source el que resuelve las ops contra lo vigente — por eso no hace falta
    // leer y re-unir el set acá, ni pasar por `setLabels`.
    const tool = getTool('set_task_labels')!
    await tool.execute({ task_id: TASK_ID, labels: ['bug', 'frontend'] }, { repoPaths: {} })
    expect(calls.setFields).toHaveLength(1)
    expect(calls.setFields[0].fields).toEqual({ Labels: '+bug,+frontend' })
  })

  it('complete_task is restricted to async providers', () => {
    // Sync (anthropic-api) infers success from stopReason and never needs
    // this — restricting to async keeps it off its tool list entirely.
    expect(getTool('complete_task')!.providerKinds).toEqual(['async'])
  })

  it('fail_task is available to both sync and async providers', () => {
    // Unlike complete_task, sync has no other way to signal an intentional
    // failure (stopReason alone can't distinguish "done" from "giving up").
    expect(getTool('fail_task')!.providerKinds).toEqual(['sync', 'async'])
  })

  it('complete_task posts a structured comment and applies the success exit', async () => {
    const tool = getTool('complete_task')!
    await tool.execute(
      {
        task_id: TASK_ID,
        what_did: ['tocó archivo A', 'abrió PR #42'],
        validations: ['bun test ok', 'biome check ok'],
      },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Queue' }), status: 'Done' },
    ])
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toContain('**Qué hice**')
    expect(body).toContain('- tocó archivo A')
    expect(body).toContain('**Validaciones**')
    expect(body).toContain('- bun test ok')
  })

  it('complete_task skips the default exit when the prompt already moved the task', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'] },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([])
  })

  it('complete_task skips the default exit when the prompt used the source-native field name (e.g. "Status")', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'Status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'] },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([])
  })

  it('una salida elegida con select_exit gana aunque el prompt ya haya movido la task', async () => {
    // El agente declara una salida extra además de la reservada `success`.
    registerPendingTask(TASK_ID, {
      task: baseTask(),
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Queue',
      exits: { success: 'Done', review: 'Review' },
    })
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    // El agente nombra una salida DECLARADA. Antes esto era `status: 'Review'`
    // — un string libre que iba derecho a applyOutcome, o sea la máquina de
    // estados en manos del modelo.
    await getTool('select_exit')!.execute({ task_id: TASK_ID, exit: 'review' }, { repoPaths: {} })
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'] },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Blocked' }), status: 'Review' },
    ])
  })

  it('fail_task posts a structured error comment AND persists error state via postError', async () => {
    const tool = getTool('fail_task')!
    await tool.execute(
      {
        task_id: TASK_ID,
        what_tried: ['probé A', 'probé B'],
        where_failed: 'B falla al compilar',
        validations: ['tsc con error TS2345'],
      },
      { repoPaths: {} },
    )
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toContain('❌ falló')
    expect(body).toContain('**Qué intenté**')
    expect(body).toContain('- probé A')
    expect(body).toContain('**Dónde falló**')
    expect(body).toContain('B falla al compilar')

    // Ambos canales: postComment (timeline) + postError (state/banner), y el
    // segundo se entera de que el fallo ya quedó comentado — es lo que hace
    // que las fuentes de GitHub no dejen un segundo comentario por lo mismo.
    expect(calls.postError).toHaveLength(1)
    expect(calls.postError[0].error).toBe('B falla al compilar')
    expect(calls.postError[0].alreadyCommented).toBe(true)
  })

  it('throws when the pending task is unknown', async () => {
    const tool = getTool('add_task_comment')!
    await expect(
      tool.execute({ task_id: 'nonexistent', body: 'x' }, { repoPaths: {} }),
    ).rejects.toThrow("No hay tarea activa con id 'nonexistent'")
  })
})

// El incidente: un agente async terminó su trabajo (commits, PR) y su
// `complete_task` rebotó con "No pending task" porque el daemon había
// reiniciado y la entrada vivía sólo en memoria. El agente leyó el rechazo
// como un problema suyo, improvisó una explicación y arregló el issue a mano
// por fuera del engine.
describe('el cierre de un run se acepta siempre', () => {
  it('sin ejecución registrada, complete_task acepta y lo dice — no rechaza', async () => {
    const tool = getTool('complete_task')!
    const out = await tool.execute(
      { task_id: 'jamas-registrada', what_did: ['hice X'], validations: ['bun test ok'] },
      { repoPaths: {} },
    )
    expect(out).toContain('Cierre aceptado')
    expect(out).not.toContain('No pending task')
  })

  it('sin ejecución registrada, fail_task también acepta', async () => {
    const tool = getTool('fail_task')!
    const out = await tool.execute(
      { task_id: 'jamas-registrada', what_tried: ['probé X'], where_failed: 'Y' },
      { repoPaths: {} },
    )
    expect(out).toContain('Cierre aceptado')
  })

  it('un cierre de un run anterior no toca al run que está trabajando', async () => {
    // El watchdog soltó un run que seguía vivo, el daemon re-despachó, y la
    // sesión vieja aparece ahora con su cierre. Lo que NO puede pasar es que
    // ese cierre liquide al agente vigente: matarle la terminal y dar su run
    // por terminado deja su cierre real descartado como duplicado — el
    // incidente original, invertido.
    removePendingTask(TASK_ID)
    let killed = 0
    registerPendingTask(TASK_ID, {
      task: baseTask(),
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Queue',
      exits: { success: 'Done' },
      runId: 'run-nuevo',
      killSession: async () => {
        killed += 1
      },
    })

    const tool = getTool('complete_task')!
    await tool.execute(
      { task_id: TASK_ID, what_did: ['hice X'], validations: [] },
      { repoPaths: {}, runId: 'run-viejo' },
    )

    expect(calls.applyTransition).toHaveLength(0)
    expect(killed).toBe(0)
    // Y el run vigente sigue registrado: nadie lo dio por terminado.
    expect(getPendingTask(TASK_ID)).toBeDefined()
    expect(getPendingTask(TASK_ID)?.runId).toBe('run-nuevo')
  })

  it('congelado: comenta contra su propia ejecución y cierra sólo esa fila', async () => {
    // Con almacenamiento durable, el cierre viejo sí aterriza: comenta y
    // cierra SU fila. Lo que no hace es mover la tarea ni tocar al run vivo.
    removePendingTask(TASK_ID)
    let killed = 0
    registerPendingTask(TASK_ID, {
      task: baseTask(),
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Queue',
      exits: { success: 'Done' },
      runId: 'run-nuevo',
      killSession: async () => {
        killed += 1
      },
    })
    const ownCalls: FakeCalls = {
      saveOutput: [],
      postComment: [],
      postError: [],
      setFields: [],
      setLabels: [],
      applyTransition: [],
      transferToRepo: [],
    }
    let finalized = 0
    setPendingTaskRehydrator(async () => ({
      entry: {
        task: baseTask(),
        manager: makeFakeManager(ownCalls),
        broadcast: () => {},
        initialStatus: 'Queue',
        exits: { success: 'Done' },
        runId: 'run-viejo',
      },
      freeze: 'hay otro run abierto sobre esta tarea',
      finalize: () => {
        finalized += 1
      },
    }))

    try {
      const tool = getTool('complete_task')!
      const out = await tool.execute(
        { task_id: TASK_ID, what_did: ['hice X'], validations: [] },
        { repoPaths: {}, runId: 'run-viejo' },
      )

      expect(out).toContain('sin transición')
      expect(ownCalls.postComment).toHaveLength(1)
      expect(ownCalls.applyTransition).toHaveLength(0)
      expect(finalized).toBe(1)
      // El run vivo, intacto.
      expect(killed).toBe(0)
      expect(getPendingTask(TASK_ID)?.runId).toBe('run-nuevo')
    } finally {
      setPendingTaskRehydrator(null)
    }
  })

  it('el cierre del run vigente sí transiciona', async () => {
    removePendingTask(TASK_ID)
    registerPendingTask(TASK_ID, {
      task: baseTask(),
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Queue',
      exits: { success: 'Done' },
      runId: 'run-1',
    })

    const tool = getTool('complete_task')!
    await tool.execute(
      { task_id: TASK_ID, what_did: ['hice X'], validations: [] },
      { repoPaths: {}, runId: 'run-1' },
    )

    expect(calls.applyTransition).toHaveLength(1)
    expect(calls.applyTransition[0].status).toBe('Done')
  })

  it('un run cancelado acepta el cierre pero no transiciona', async () => {
    // Cancelado a propósito (cancel manual, o el reconciliador porque alguien
    // movió el issue a mano): el estado de la tarea ya lo decidió otro.
    const entry = getPendingTask(TASK_ID)!
    entry.cancelled = true

    const tool = getTool('complete_task')!
    const out = await tool.execute(
      { task_id: TASK_ID, what_did: ['hice X'], validations: [] },
      { repoPaths: {} },
    )

    expect(out).toContain('sin transición')
    expect(calls.postComment).toHaveLength(1)
    expect(calls.applyTransition).toHaveLength(0)
  })
})

// ─── Cierre repetido dentro del MISMO run ────────────────────────────────────

describe('fail_task llamado dos veces en el mismo run', () => {
  afterEach(() => setPendingTaskRehydrator(null))

  it('no vuelve a comentar ni a re-aplicar la salida de error', async () => {
    // Escenario real: un agente sync llama `fail_task`, recibe un string de
    // éxito (la tool no corta el loop) y la vuelve a llamar. La primera
    // llamada hace `removePendingTask`, así que la segunda ya no encuentra la
    // entrada en memoria y cae al rehidratador — que reconstruye la ejecución
    // desde la fila del execution log.
    //
    // La fila de un run SYNC nunca lleva `finalizedByTool` (Agent.run sólo lo
    // escribe en la rama async), así que el rehidratador la reconstruye con
    // `alreadyClosed: false` y la segunda llamada corre entera otra vez:
    // dos comentarios más y la salida de error aplicada por segunda vez.
    registerPendingTask(TASK_ID, {
      task: baseTask(),
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Queue',
      exits: { error: 'Blocked' },
    })
    // El rehidratador del daemon reconstruye la entrada desde la fila del log.
    // `alreadyClosed` sale de `row.finalizedByTool`, que en sync queda en false.
    setPendingTaskRehydrator(async () => ({
      entry: {
        task: baseTask(),
        manager: makeFakeManager(calls),
        broadcast: (msg: object) => broadcasts.push(msg),
        initialStatus: 'Queue',
        exits: { error: 'Blocked' },
      },
      alreadyClosed: false,
    }))

    const tool = getTool('fail_task')!
    const input = {
      task_id: TASK_ID,
      what_tried: ['intenté algo'],
      where_failed: 'acá',
      validations: [],
    }
    await tool.execute(input, { repoPaths: {} })
    await tool.execute(input, { repoPaths: {} })

    expect(calls.postComment).toHaveLength(1)
    expect(calls.postError).toHaveLength(1)
    expect(calls.applyTransition).toHaveLength(1)
  })
})

describe('transfer_task_repo', () => {
  const REPO_PATHS = { subscriptions: '/tmp/subs', 'platform-infrastructure': '/tmp/infra' }
  const CTX = { repoPaths: REPO_PATHS, projectRepos: Object.keys(REPO_PATHS) }

  function registerWith(repos: string[]) {
    removePendingTask(TASK_ID)
    registerPendingTask(TASK_ID, {
      task: { ...baseTask(), repos },
      manager: makeFakeManager(calls),
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Refine',
      exits: { success: 'Refined', error: '$set:Labels=+blocked' },
    })
  }

  it('mueve el issue y cierra el run SIN aplicar ninguna salida', async () => {
    registerWith(['subscriptions'])
    const tool = getTool('transfer_task_repo')!

    const result = await tool.execute(
      {
        task_id: TASK_ID,
        repo: 'platform-infrastructure',
        reason: 'los manifiestos k8s viven ahí',
      },
      CTX,
    )

    expect(calls.transferToRepo).toHaveLength(1)
    expect(calls.transferToRepo[0].targetRepo).toBe('platform-infrastructure')
    expect(result).toContain('platform-infrastructure')
    expect(result).toContain('4321')
    // El status no se toca: la tarea se queda donde está para que el próximo
    // scan la re-despache ya en el repo nuevo.
    expect(calls.applyTransition).toHaveLength(0)
    // Y la pending task queda soltada — es lo que hace que Agent.ts saltee la
    // transición por defecto (`finalizedByTool`).
    expect(getPendingTask(TASK_ID)).toBeUndefined()
  })

  it('rechaza un repo que el proyecto no declara', async () => {
    registerWith(['subscriptions'])
    const tool = getTool('transfer_task_repo')!

    await expect(
      tool.execute({ task_id: TASK_ID, repo: 'ia-flow-inbox', reason: 'x' }, CTX),
    ).rejects.toThrow(/no es un repo de este proyecto/)
    expect(calls.transferToRepo).toHaveLength(0)
    expect(getPendingTask(TASK_ID)).toBeDefined()
  })

  it('rechaza mover la tarea al repo en el que ya está', async () => {
    registerWith(['subscriptions'])
    const tool = getTool('transfer_task_repo')!

    await expect(
      tool.execute({ task_id: TASK_ID, repo: 'subscriptions', reason: 'x' }, CTX),
    ).rejects.toThrow(/ya está en/)
    expect(calls.transferToRepo).toHaveLength(0)
  })

  it('sin roster no valida el destino, pero igual transfiere', async () => {
    registerWith(['subscriptions'])
    const tool = getTool('transfer_task_repo')!

    await tool.execute({ task_id: TASK_ID, repo: 'cualquier-cosa', reason: 'x' }, { repoPaths: {} })
    expect(calls.transferToRepo).toHaveLength(1)
  })

  // El roster y los clones locales NO son lo mismo: `repoPaths` deja afuera
  // los repos sin bajar, y en un run remoto el agent-host lo reescribe con los
  // del workspace de la tarea. Validar contra él rechazaba destinos válidos.
  it('acepta un repo del roster aunque no tenga clone local', async () => {
    registerWith(['subscriptions'])
    const tool = getTool('transfer_task_repo')!

    await tool.execute(
      { task_id: TASK_ID, repo: 'eks', reason: 'los manifiestos viven ahí' },
      // Lo que ve un run remoto: repoPaths reescrito con el repo de la tarea,
      // pero el roster completo del proyecto intacto.
      {
        repoPaths: { subscriptions: '/state/repos/la-haus/subscriptions' },
        projectRepos: ['subscriptions', 'eks'],
      },
    )

    expect(calls.transferToRepo).toHaveLength(1)
    expect(calls.transferToRepo[0].targetRepo).toBe('eks')
  })

  it('falla claro cuando el source no sabe transferir', async () => {
    removePendingTask(TASK_ID)
    const { transferToRepo, ...withoutTransfer } = makeFakeManager(calls)
    registerPendingTask(TASK_ID, {
      task: { ...baseTask(), repos: ['subscriptions'] },
      manager: withoutTransfer as TaskSource,
      broadcast: (msg) => broadcasts.push(msg),
      initialStatus: 'Refine',
      exits: { success: 'Refined' },
    })
    const tool = getTool('transfer_task_repo')!

    await expect(
      tool.execute({ task_id: TASK_ID, repo: 'platform-infrastructure', reason: 'x' }, CTX),
    ).rejects.toThrow(/no sabe mover un issue de repositorio/)
  })
})
