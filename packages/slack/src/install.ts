// El único punto de entrada del paquete — y lo que lo hace plug-and-play.
//
// La idea: **sacar Slack de un deploy es sacar esta llamada**. Todo lo que el
// paquete le pide al host viaja por `deps` (el repo de repos, el de proyectos,
// su logger, cómo resolver la tarea en vuelo) y todo lo que el host necesita
// del paquete vuelve en el objeto que devuelve. No hay un segundo cable
// escondido: ningún módulo de acá importa `apps/server`, y ninguna ruta del
// server importa un módulo interno de acá.
//
// Y en caliente: **la credencial es el interruptor** (ver `enabled.ts`). Sin
// `SLACK_BOT_TOKEN` las tools no se registran, el directorio devuelve vacío y
// los endpoints contestan 503 con el motivo. Como el token puede llegar
// después del boot —el operador lo pega en Configuración y eso escribe SQLite,
// no el ambiente del proceso—, `sync()` vuelve a mirar y ajusta el registry sin
// reiniciar.
import type { IRepoRepository } from '@ia-flow/agent-engine'
import type { ProjectSource } from '@ia-flow/issue-sources'
import { unregisterTool } from '@ia-flow/tools'
import { chatGetPermalink, postMessage } from './client.js'
import { SlackDirectory } from './directory.js'
import { type SlackStatus, isSlackEnabled, slackStatus } from './enabled.js'
import { type LoggerFactory, createLogger, setLoggerFactory } from './logger.js'
import { SLACK_REVIEW_TOOL, registerSlackReviewTool, setSlackReviewPort } from './review-tool.js'
import {
  type IProjectLookup,
  RequestSlackReviewUseCase,
} from './review/RequestSlackReviewUseCase.js'
import { SLACK_TOOL_NAMES, registerSlackTools } from './tools.js'
import { SlackWebhookTranslator } from './webhook.js'

/**
 * Lo que la tool `request_slack_review` necesita del engine para funcionar:
 * sólo recibe un id de tarea, y el proyecto sale del run en vuelo.
 *
 * Es opcional porque no todo proceso que habla con Slack despacha agentes: un
 * flavor que sólo expone la API tiene directorio y pedido de review por HTTP,
 * pero ninguna corrida sobre la cual resolver el proyecto.
 */
export interface SlackRuntime {
  /** El proyecto de una tarea que este proceso está corriendo, o `undefined`. */
  resolveProjectId(taskId: string): string | undefined
  /** La fuente de issues de ese proyecto. */
  getSource(projectId: string): ProjectSource
}

export interface SlackIntegrationDeps {
  repoRepo: IRepoRepository
  projectRepo: IProjectLookup
  /** El logger real del host. Sin esto el paquete loguea a un no-op. */
  logger?: LoggerFactory
  runtime?: SlackRuntime
}

/**
 * Slack, montado.
 *
 * Las tres piezas se construyen SIEMPRE, aunque no haya credencial: sus
 * consumidores del server (la ruta del directorio, la del pedido de review, la
 * lista de traductores de webhook) las quieren como valores, no como
 * `undefined` que cada uno tenga que sortear. Lo que cambia con la credencial
 * es qué hacen — el directorio devuelve vacío con su motivo, el use-case falla
 * con el error del cliente, y las tools directamente no existen.
 */
export class SlackIntegration {
  readonly directory = new SlackDirectory()
  readonly translator = new SlackWebhookTranslator()
  readonly reviewUseCase: RequestSlackReviewUseCase

  private toolsRegistered = false

  constructor(private readonly deps: SlackIntegrationDeps) {
    if (deps.logger) setLoggerFactory(deps.logger)
    this.reviewUseCase = new RequestSlackReviewUseCase(deps.repoRepo, deps.projectRepo, {
      postMessage: (input) => postMessage(input),
      getPermalink: async (input) => (await chatGetPermalink(input)).permalink,
    })
    this.sync()
  }

  /** ¿Hay credencial ahora mismo? Se pregunta, no se guarda — ver `enabled.ts`. */
  get enabled(): boolean {
    return isSlackEnabled()
  }

  /** Lo que se publica por HTTP para que la web no ofrezca lo que no funciona. */
  status(): SlackStatus {
    return slackStatus()
  }

  /**
   * Pone el registry de tools de acuerdo con la credencial actual.
   *
   * Se llama al construir, después de `envRepo.loadIntoProcess()` (que es
   * cuando aparece el token guardado en la DB) y cada vez que alguien toca una
   * variable de Slack desde Configuración. Es idempotente en las dos
   * direcciones: registrar pisa por nombre y desregistrar un nombre ausente
   * devuelve `false`.
   */
  sync(): void {
    if (this.enabled) this.register()
    else this.unregister()
  }

  // El registry de tools es del PROCESO, no de esta instancia. Por eso las dos
  // funciones de abajo hacen su trabajo entero cada vez y no cortan por el
  // flag: `toolsRegistered` sólo evita repetir el log. Cortar por él dejaba
  // tools de una instancia anterior vivas en el registry — que es exactamente
  // el estado inválido que este paquete existe para evitar.
  private register(): void {
    registerSlackTools()
    if (this.deps.runtime) {
      setSlackReviewPort({ requestReview: (input) => this.requestReviewFromTool(input.taskId) })
      registerSlackReviewTool()
    } else {
      // Sin runtime la tool no tiene cómo resolver el proyecto de la tarea:
      // ofrecerla sólo para que conteste que no está disponible es peor que no
      // ofrecerla.
      setSlackReviewPort(null)
      unregisterTool(SLACK_REVIEW_TOOL)
    }
    if (this.toolsRegistered) return
    this.toolsRegistered = true
    createLogger('slack').info(
      { tools: SLACK_TOOL_NAMES.length + (this.deps.runtime ? 1 : 0) },
      'Slack habilitado',
    )
  }

  private unregister(): void {
    for (const name of SLACK_TOOL_NAMES) unregisterTool(name)
    unregisterTool(SLACK_REVIEW_TOOL)
    setSlackReviewPort(null)
    if (!this.toolsRegistered) return
    this.toolsRegistered = false
    createLogger('slack').warn({}, 'Slack deshabilitado: sin SLACK_BOT_TOKEN')
  }

  /**
   * El puente entre la tool y el use-case.
   *
   * Vive acá y no en el composition root del server porque es conocimiento de
   * Slack: qué se le contesta al agente cuando el review sale, y qué cuando el
   * proyecto no se puede resolver. El host sólo aporta los dos datos que él
   * tiene (el proyecto del run y la fuente).
   */
  private async requestReviewFromTool(taskId: string): Promise<string> {
    const runtime = this.deps.runtime
    if (!runtime) return 'El pedido de review en Slack no está disponible en este proceso.'
    const projectId = runtime.resolveProjectId(taskId)
    if (!projectId) return `No se pudo resolver el proyecto de la tarea '${taskId}'.`
    const result = await this.reviewUseCase.execute(
      // `allowFailedCi` porque el agente ya decidió: el gate de confirmación es
      // de la UI, donde hay un humano a quien preguntarle.
      { projectId, taskId, allowFailedCi: true },
      runtime.getSource(projectId),
    )
    const who = result.reviewers.map((r) => r.name ?? r.id).join(', ')
    const where = result.kind === 're-review' ? 'en el hilo existente' : 'en un hilo nuevo'
    return `Review pedido en ${result.channel} ${where} a ${who} (PR #${result.prNumber}).${
      result.threadNotPersisted ? ` Aviso: ${result.threadNotPersisted}` : ''
    }`
  }
}

export function installSlack(deps: SlackIntegrationDeps): SlackIntegration {
  return new SlackIntegration(deps)
}

/**
 * Sólo las tools, para un proceso que EJECUTA agentes pero no administra nada
 * — el `apps/agent-host`.
 *
 * El loop de tools de un run remoto corre allá (ver el CLAUDE.md de la raíz),
 * así que las `slack_*` tienen que estar en SU registry o un agente que las
 * declare se queda sin ellas. Lo que no va es `request_slack_review`: el pedido
 * lo resuelve el daemon, que es el único con los repos y la fuente.
 *
 * A diferencia de `installSlack` no hace falta un `sync()` después: el
 * agent-host toma sus variables del ambiente del proceso, no de una tabla que
 * se carga más tarde.
 */
export function installSlackTools(opts: { logger?: LoggerFactory } = {}): boolean {
  if (opts.logger) setLoggerFactory(opts.logger)
  if (!isSlackEnabled()) return false
  registerSlackTools()
  return true
}
