/**
 * Lo que el asistente propone hacer con el board: mover una card de columna, sumar un issue que no
 * está y ponerle o sacarle labels a una tarea. Como con las acciones, NO lo hace: valida contra el
 * board (que la columna exista, que la card esté —o no esté—) y muestra la propuesta; la persona la
 * confirma con su login y la web o el menú llaman al endpoint (`…/status`, `/api/board/items`,
 * `…/labels`), que vuelve a chequear todo con el permiso de esa persona.
 */
import type { AssistantProposal, AssistantScope, InboxItem, InboxProject } from '@ia-flow/shared'
import type { InboxService } from '../inbox/InboxService.js'

export interface BoardProposalsContext {
  scope: AssistantScope
  /** La sesión es la de una pipeline: nadie mira, así que no se propone nada del board. */
  unattended: boolean
  /** La tarea, si cae en el contexto (si no, tira con un error que el modelo lee). */
  task(ref: unknown): Promise<InboxItem>
  inbox: Pick<InboxService, 'inbox' | 'item'>
  emit(proposal: AssistantProposal): void
}

const SHOWN = 'Propuesta mostrada. NO está hecha: la persona decide.'

const ISSUE_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/
const ISSUE_REF = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

/** `owner/repo#n` o el link del issue → `owner/repo#n`. */
function issueRef(input: unknown): string {
  const text = String(input ?? '').trim()
  const match = ISSUE_URL.exec(text) ?? ISSUE_REF.exec(text)
  if (!match) throw new Error(`"${text}" no es owner/repo#n ni el link de un issue`)
  return `${match[1]}/${match[2]}#${match[3]}`
}

/** Una lista de labels del modelo: sin vacíos ni repetidos. */
function labelList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input.map((label) => String(label).trim()).filter(Boolean))]
}

const isLive = (item: InboxItem) =>
  item.execution?.status === 'running' || item.execution?.status === 'paused'

export class BoardProposals {
  constructor(private readonly ctx: BoardProposalsContext) {}

  private assertAttended(): void {
    if (this.ctx.unattended) {
      throw new Error('Fuera de una conversación no se proponen cambios al board')
    }
  }

  private async projects(): Promise<InboxProject[]> {
    const projectId = this.ctx.scope.kind === 'project' ? this.ctx.scope.project_id : undefined
    return (await this.ctx.inbox.inbox(projectId)).projects
  }

  /** Que `status` sea una columna del board del proyecto; uno que no declara columnas acepta todo. */
  private async assertColumn(projectId: string, status: string): Promise<void> {
    const project = (await this.projects()).find((candidate) => candidate.id === projectId)
    const columns = project?.statuses ?? []
    if (columns.length > 0 && !columns.includes(status)) {
      throw new Error(
        `"${status}" no es una columna del board de ${projectId}: ${columns.join(', ')}`,
      )
    }
  }

  /** Mover la card a `status`. Con un agente trabajando no: primero hay que pedirle que pare. */
  async move(input: { ref?: unknown; status?: unknown; reason?: unknown }): Promise<string> {
    this.assertAttended()
    const item = await this.ctx.task(input.ref)
    const status = String(input.status ?? '').trim()
    if (!status) throw new Error('¿A qué columna? Falta status')
    await this.assertColumn(item.project_id, status)
    if (item.status === status) throw new Error(`${item.ref} ya está en ${status}`)
    if (isLive(item)) {
      throw new Error(
        `${item.ref} tiene un agente trabajando: no se mueve. Si conviene, proponé primero stop`,
      )
    }
    this.ctx.emit({
      id: globalThis.crypto.randomUUID(),
      kind: 'move',
      ref: item.ref,
      status,
      ...(item.status ? { from: item.status } : {}),
      label: `Mover a ${status}`,
      reason: String(input.reason ?? ''),
    })
    return SHOWN
  }

  /** El proyecto al que iría un issue: el del contexto, el pedido, o el único del runner. */
  private async projectFor(wanted: unknown): Promise<string> {
    const asked = String(wanted ?? '').trim()
    const { scope } = this.ctx
    if (scope.kind === 'project') {
      if (asked && asked !== scope.project_id) {
        throw new Error(
          `Fuera de contexto: esta conversación es sobre el proyecto ${scope.project_id}`,
        )
      }
      return scope.project_id
    }
    const ids = (await this.projects()).map((project) => project.id)
    if (asked) {
      if (!ids.includes(asked)) throw new Error(`"${asked}" no es un proyecto: ${ids.join(', ')}`)
      return asked
    }
    if (ids.length !== 1) throw new Error(`¿A qué proyecto? Pasá project_id: ${ids.join(', ')}`)
    return ids[0] as string
  }

  /** Sumar al board un issue que no está, en `status` (o la columna de entrada). */
  async addToBoard(input: {
    issue?: unknown
    status?: unknown
    project_id?: unknown
    reason?: unknown
  }): Promise<string> {
    this.assertAttended()
    const ref = issueRef(input.issue)
    const { scope } = this.ctx
    if (scope.kind === 'task' && ref !== scope.ref) {
      throw new Error(`Fuera de contexto: esta conversación es sobre ${scope.ref}`)
    }
    const projectId = await this.projectFor(input.project_id)
    const existing = await this.ctx.inbox.item(ref)
    if (existing) {
      const where = existing.status ? ` (en ${existing.status})` : ''
      throw new Error(
        `${ref} ya está en el board${where}: si hay que cambiarla de columna, proponé moverla`,
      )
    }
    const status = String(input.status ?? '').trim()
    if (status) await this.assertColumn(projectId, status)
    this.ctx.emit({
      id: globalThis.crypto.randomUUID(),
      kind: 'add_to_board',
      issue: ref,
      project_id: projectId,
      ...(status ? { status } : {}),
      label: status ? `Agregar al board en ${status}` : 'Agregar al board',
      reason: String(input.reason ?? ''),
    })
    return SHOWN
  }

  /**
   * Un issue nuevo, armado a partir de lo que contó la persona, para que entre al board y se
   * refine: se abre en un repo del catálogo del proyecto y queda en `status` (Todo si no se dice).
   * NO lo crea: la persona lo confirma (y puede cambiar la columna) con su login.
   */
  async draftIssue(input: {
    repo?: unknown
    title?: unknown
    body?: unknown
    labels?: unknown
    status?: unknown
    project_id?: unknown
    reason?: unknown
  }): Promise<string> {
    this.assertAttended()
    if (this.ctx.scope.kind === 'task') {
      throw new Error(
        'En el contexto de una tarea no se abre otra: pedilo desde el chat general o del proyecto',
      )
    }
    const projectId = await this.projectFor(input.project_id)
    const project = (await this.projects()).find((candidate) => candidate.id === projectId)
    const catalog = project?.repos ?? []
    const repo = String(input.repo ?? '').trim()
    const known = catalog.find((candidate) => candidate.toLowerCase() === repo.toLowerCase())
    if (catalog.length > 0 && !known) {
      throw new Error(
        `"${repo}" no es un repo de ${projectId}. Elegí uno de: ${catalog.join(', ')} — si no está claro, preguntale a la persona`,
      )
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(known ?? repo)) {
      throw new Error(`El repo tiene que ser owner/repo, no "${repo}"`)
    }
    const title = String(input.title ?? '').trim()
    const body = String(input.body ?? '').trim()
    if (!title || !body) throw new Error('El issue necesita título y cuerpo')
    const status = String(input.status ?? '').trim()
    if (status) await this.assertColumn(projectId, status)
    const labels = labelList(input.labels)
    const where = known ?? repo
    this.ctx.emit({
      id: globalThis.crypto.randomUUID(),
      kind: 'issue',
      repo: where,
      title,
      body,
      ...(labels.length ? { labels } : {}),
      label: `Crear en ${where} y sumarlo al board`,
      reason: String(input.reason ?? ''),
      board: { project_id: projectId, ...(status ? { status } : {}) },
    })
    return `${SHOWN} En tu respuesta no repitas el título ni el cuerpo: la persona los ve en la card.`
  }

  /** Poner y sacar labels del issue de una tarea: p.ej. sacar `blocked` para destrabarla. */
  async labels(input: {
    ref?: unknown
    add?: unknown
    remove?: unknown
    reason?: unknown
  }): Promise<string> {
    this.assertAttended()
    const item = await this.ctx.task(input.ref)
    const add = labelList(input.add)
    const remove = labelList(input.remove)
    if (add.length + remove.length === 0)
      throw new Error('Pasá qué labels poner (add) o sacar (remove)')
    const both = add.filter((label) => remove.includes(label))
    if (both.length > 0) throw new Error(`¿Poner o sacar ${both.join(', ')}? No las dos`)
    const has = add.filter((label) => item.labels.includes(label))
    if (has.length > 0) throw new Error(`${item.ref} ya tiene ${has.join(', ')}`)
    const missing = remove.filter((label) => !item.labels.includes(label))
    if (missing.length > 0) {
      throw new Error(
        `${item.ref} no tiene ${missing.join(', ')}. Tiene: ${item.labels.join(', ') || 'ninguno'}`,
      )
    }
    const label = [
      ...(add.length ? [`Poner ${add.join(', ')}`] : []),
      ...(remove.length ? [`${add.length ? 'sacar' : 'Sacar'} ${remove.join(', ')}`] : []),
    ].join(' y ')
    this.ctx.emit({
      id: globalThis.crypto.randomUUID(),
      kind: 'labels',
      ref: item.ref,
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
      label,
      reason: String(input.reason ?? ''),
    })
    return SHOWN
  }
}
