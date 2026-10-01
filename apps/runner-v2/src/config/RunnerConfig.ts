/**
 * Lo que el runner lee de `.config/`: `runner.yaml` es el índice de todo y nada se descubre por
 * carpeta — cada cosa se declara.
 *
 *   runner.yaml      scope runner: settings, identidad de GitHub, providers, MCP, `systemPrompts`
 *                    (el catálogo que cualquier agente nombra por id), `engine:` (cómo
 *                    corre el engine: `engine/mountEngine.ts`) y `sources:` (qué corre: la fuente
 *                    global —`agents`, `pipelines`—, las `actions` globales y los `projects`,
 *                    cada uno la ruta a su `project.yaml` o el proyecto inline)
 *   project.yaml     scope proyecto: board y prefijo de rama (el runner), los defaults de su
 *                    fuente (`systemPrompts`, `onError`, `onInterrupt`, `report`, `vars`), sus `agents`,
 *                    `pipelines`, `actions` y `repos`
 *
 * `agents`, `pipelines` y `repos` aceptan, solos o en lista: un directorio, un archivo, un glob en
 * el nombre del archivo (`./pipelines/1*.yaml`) o el documento inline; `actions` (código), sólo
 * rutas. Las rutas son relativas al archivo que las declara.
 *
 * Todo `.strict()`: una clave mal escrita rompe el arranque en vez de quedar como config que nadie
 * lee. `applyRunnerEnv` vuelca `github`/`settings` al env — **el env real gana**, así un PEM local
 * se apunta con IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH sin editar el archivo. `github.privateKeyPath`
 * es relativo a `runner.yaml` (o `~/…`, o absoluto): el PEM queda fuera de git (`*.pem`), la ruta no.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ConditionRow, SystemPromptCatalog } from '@ia-flow/agent-engine'
import { expandPath, type YamlSourceSpec } from '@ia-flow/agent-engine-datasource-yaml'
import { ConditionRows } from '@ia-flow/agent-engine-definitions'
import { AcceptRow, HostName } from '@ia-flow/provider-remote'
import type { AssistantAgent } from '@ia-flow/shared'
import type { SlackReviewConfig, SlackUserDirectory } from '@ia-flow/slack-api'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  assistantAgents,
  BUILTIN_CAPABILITIES,
  BUILTIN_CAPABILITY_AGENTS,
  isAssistantCapability,
} from '../capabilities/index.js'
import { EngineSection } from '../engine/mountEngine.js'
import {
  DEFAULT_WORKING_MARKER,
  type WorkingMarker,
  WorkingMarkerSchema,
} from '../engine/workingMarker.js'
import { InboxSection, type InboxSettings } from '../inbox/InboxSection.js'
import { type McpHostEntry, McpHostEntrySchema } from '../mcp/mcpHost.js'
import { defaultDatabasePath, runnerHome } from './runnerHome.js'

const McpEntrySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.strictObject({
    type: z.enum(['http', 'sse', 'stdio']),
    url: z.string().optional(),
    /** Con `${VAR}`: se resuelve del ambiente (y `${GITHUB_TOKEN}` es el token de la App). */
    authorizationToken: z.string().optional(),
    /** El id de un `mcpHost` de este runner: se prueba contra su proceso local y no contra `url`
     *  (la pública, que es este mismo runner y todavía no escucha al resolver el catálogo). */
    hosted: z.string().min(1).optional(),
  }),
})
export type McpEntry = z.infer<typeof McpEntrySchema>

/** Un directorio, un archivo o un glob (relativos al archivo que lo declara), o el documento. */
const Entry = z.union([z.string().min(1), z.record(z.string(), z.unknown())])
/** Una entrada sola o una lista. */
const Entries = z.union([Entry, z.array(Entry)])
/** Sólo rutas: lo que es código (las actions) no va inline. */
const Paths = z.union([z.string().min(1), z.array(z.string().min(1))])

/** Los defaults de una fuente: los valida el schema de la fuente (`SourceDoc`) al leerla. */
const SourceDefaults = {
  vars: z.record(z.string(), z.unknown()).optional(),
  systemPrompts: z.unknown().optional(),
  onError: z.unknown().optional(),
  onInterrupt: z.unknown().optional(),
  report: z.unknown().optional(),
}

/** A quién taguea un pedido de review en Slack: `<@id>`. */
const SlackMemberRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  isBot: z.boolean().optional(),
})

/** El pedido de review en Slack de un proyecto, o de un repo de su catálogo (que lo pisa campo
 *  por campo): el canal, a quién taguear y con qué texto. */
export const SlackReviewSchema = z.object({
  slackReviewChannel: z.string().min(1).optional(),
  slackReviewers: z.array(SlackMemberRefSchema).optional(),
  slackReviewMessage: z
    .strictObject({ first: z.string().optional(), reReview: z.string().optional() })
    .optional(),
})

/** Un proyecto (su `project.yaml`, o inline en `runner.yaml`). */
export const ProjectFileSchema = z.strictObject({
  /** El GitHub Project v2 del proyecto: `https://github.com/orgs/<org>/projects/<n>`. */
  board: z.string().regex(/github\.com\/orgs\/[^/]+\/projects\/\d+/, 'un GitHub Project v2 de org'),
  /** Con esto, `task.branch` = `<branchPrefix><número>`. Sin esto, como ia-flow: la rama
   *  vinculada al issue, o la que propone la capacidad `branchName` (`feat/<slug>`). */
  branchPrefix: z.string().min(1).optional(),
  /** Qué cards del board muestra la bandeja: filas como el `when` de una pipeline (se combinan de
   *  izquierda a derecha) sobre la card —sólo campos `item.*`: `item.labels`, `item.status`,
   *  `item.type`, `item.repos`, `item.blocked`—. No toca al intake: qué tasks publican eventos lo
   *  decide su propio `with.when` (`resolve_task`). Sin esto, todas las cards del board. */
  when: ConditionRows.refine(
    (rows) =>
      rows.every(
        (row) =>
          row.field.startsWith('item.') &&
          (row.valueFrom === undefined || row.valueFrom.startsWith('item.')),
      ),
    'el when del proyecto sólo mira la card: campos item.* (labels, status, type, repos, blocked)',
  ).optional(),
  /** Cuántas corridas de sus tasks a la vez (debajo de `engine.executions.maxConcurrent`). */
  maxConcurrent: z.number().int().positive().optional(),
  /** La marca "en curso" de una task en el board mientras su ejecución corre (el `Working = Yes`
   *  de ia-flow). Ausente: `{ field: Working, on: Yes }` (apagar = vaciar); `null`: sin marca. */
  workingMarker: WorkingMarkerSchema.nullable().optional(),
  /** El pedido de review en Slack (`request_slack_review`): canal, a quién taguear y con qué
   *  texto. Un repo del catálogo los pisa campo por campo. */
  ...SlackReviewSchema.shape,
  ...SourceDefaults,
  agents: Entries.optional(),
  pipelines: Entries.optional(),
  actions: Paths.optional(),
  /** El catálogo de repos del proyecto. */
  repos: Entries.optional(),
})
type ProjectFile = z.infer<typeof ProjectFileSchema>

export const RunnerFileSchema = z.strictObject({
  /** Slack: quién es cada persona allá. `users` mapea el login de GitHub al usuario de Slack, para
   *  taguear al asignado de una task (`request_slack_review`). Se lee al arrancar. */
  slack: z
    .strictObject({
      users: z
        .record(z.string().min(1), SlackMemberRefSchema)
        .refine((users) => {
          const ids = Object.values(users).map((user) => user.id)
          return new Set(ids).size === ids.length
        }, 'dos logins con el mismo id de Slack: la búsqueda inversa (Slack → GitHub) sería ambigua')
        .optional(),
    })
    .optional(),
  settings: z
    .strictObject({
      port: z.number().int().positive().optional(),
      /** OpenTelemetry: a dónde van las trazas y los logs (OTLP) y cómo se llama el servicio. Sin
       *  `endpoint` (ni `OTEL_EXPORTER_OTLP_ENDPOINT`), no se exporta nada. */
      telemetry: z
        .strictObject({
          endpoint: z.string().min(1).optional(),
          serviceName: z.string().min(1).optional(),
          environment: z.string().min(1).optional(),
          /** Nivel mínimo de los logs (`LOG_LEVEL`). En `debug` los providers vuelcan cada
           *  request y respuesta de su API, con las credenciales tapadas. */
          logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        })
        .optional(),
    })
    .optional(),
  github: z
    .strictObject({
      mode: z.enum(['auto', 'static', 'gh-cli', 'github-app']).optional(),
      appId: z.string().optional(),
      installationId: z.string().optional(),
      /** La ruta al PEM de la App: relativa a `runner.yaml`, `~/…` o absoluta. El PEM, nunca en git. */
      privateKeyPath: z.string().optional(),
      /** El client id de la GitHub App: el login de cada persona en la web (device flow). */
      clientId: z.string().optional(),
    })
    .optional(),
  /** Los defaults de cada provider para todos sus agentes (`anthropic-api: { maxTokens, … }`). */
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /**
   * `--host`: esta máquina le presta su CLI `claude` a un runner (`@ia-flow/provider-remote`). Se
   * suscribe a él y le pide tareas — sólo conexiones de salida, sin puerto ni URL pública. Del
   * otro lado aparece como `remote:<name>`. El token (el de hosts del runner) va en
   * IA_FLOW_HOST_TOKEN, nunca acá.
   */
  host: z
    .strictObject({
      /** El nombre con el que se suscribe: `remote:<name>`. Env: IA_FLOW_HOST_NAME (gana). */
      name: HostName.optional(),
      /** La base pública del runner (`https://ia-flow.example.com`). Env: IA_FLOW_HOST_RUNNER_URL
       *  (gana). */
      runner: z.url().optional(),
      /** Qué provider presta: una entrada `type: claude-cli` de `providers`, con sus defaults
       *  (modo, modelo, tope de minutos). Default: la única que haya. */
      provider: z.string().min(1).optional(),
      /** Cuántas corridas a la vez toma. Default: 1. */
      maxConcurrent: z.number().int().positive().optional(),
      /** Qué trabajo toma: condiciones como el `when` de las pipelines, sobre el payload del
       *  evento más `agentId` y `eventType` (ej. `{ field: repo, op: in, value: [eks] }`). Sin
       *  condiciones, todo. Las evalúa el runner, antes de darle la tarea. */
      accepts: z.array(AcceptRow).optional(),
    })
    .optional(),
  /** Los system prompts del deploy que cualquier agente nombra por id
   *  (`systemPrompts: [{ id: reglas }]`), en vez de copiar el texto. Uno que no está: el engine
   *  avisa y el agente corre sin él. Lo que un provider exige en todo request no va acá: va en
   *  `providers.<id>.systemPrompts`. */
  systemPrompts: z
    .array(z.strictObject({ id: z.string().min(1), text: z.string().min(1) }))
    .refine((entries) => {
      const ids = entries.map((entry) => entry.id)
      return new Set(ids).size === ids.length
    }, 'dos system prompts con el mismo id')
    .default([]),
  mcp: z.array(McpEntrySchema).default([]),
  /** Los MCP que levanta el runner y publica en `/mcp/<id>` de su puerto (`mcp/mcpHost.ts`), por
   *  id. Sólo con `--serve`. Para que un agente los use, van también en `mcp` con `hosted: <id>`. */
  mcpHost: z.record(z.string().regex(/^[a-z0-9-]+$/), McpHostEntrySchema).default({}),
  /** Cómo corre el engine (`engine/mountEngine.ts`). */
  engine: EngineSection.default({}),
  /** La bandeja de la web (`inbox/InboxSection.ts`). */
  inbox: InboxSection.prefault({}),
  /** Qué corre: la composición del runner, que el engine sólo ve como fuentes ya armadas. */
  sources: z
    .strictObject({
      /** La fuente global: la que recibe todos los eventos (ej. los webhooks crudos). */
      agents: Entries.optional(),
      pipelines: Entries.optional(),
      /** Quién cumple cada capacidad del engine (`whenText`, `fileFocus`): un paso de la fuente
       *  global, típicamente `{ agent: <id> }`. Sin una, esa capacidad está apagada. Las del
       *  asistente (`assistant`, `assistant.<id>`) llevan además `label` y `description`. */
      capabilities: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
      /** Las actions globales: las ve toda fuente. */
      actions: Paths.optional(),
      /** Cada proyecto: la ruta a su `project.yaml`, o el proyecto inline. */
      projects: z.record(z.string(), z.union([z.string().min(1), ProjectFileSchema])).default({}),
    })
    .default({ projects: {} }),
})
type RunnerFile = z.infer<typeof RunnerFileSchema>

export const RepoDefSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
})
export type RepoDef = z.infer<typeof RepoDefSchema> & { projectId: string }

/** Un proyecto: lo que el runner sabe de él, sus actions y cómo leer su fuente. */
export interface ProjectConfig {
  id: string
  /** Contra qué se resuelven sus rutas: la carpeta de su `project.yaml`. */
  dir: string
  board: { owner: string; number: number }
  branchPrefix?: string
  /** Ver `when` en `project.yaml`: vacío, todas las cards del board. */
  when: ConditionRow[]
  /** La marca "en curso" (ya con el default); `null`: sin marca. */
  workingMarker: WorkingMarker | null
  /** Ver `maxConcurrent` en `project.yaml`. */
  maxConcurrent?: number
  /** Ver `slackReview*` en `project.yaml`. */
  slackReview: SlackReviewConfig
  repos: RepoDef[]
  /** Los módulos de sus actions. */
  actions: string[]
  /** Su fuente, releída del índice cuando cambia (`watch`). */
  source: { spec: () => YamlSourceSpec; watch: string[] }
}

export interface RunnerConfig {
  /** La carpeta de la definición (`.config`). */
  dir: string
  /** `runner.yaml`: el índice, y la config del engine en su sección `engine:`. */
  runnerPath: string
  settings: NonNullable<RunnerFile['settings']>
  github: NonNullable<RunnerFile['github']>
  /** `slack.users` de `runner.yaml`: login de GitHub → usuario de Slack. */
  slack: { users: SlackUserDirectory }
  providers: Record<string, Record<string, unknown>>
  host: NonNullable<RunnerFile['host']>
  /** `systemPrompts` de `runner.yaml`: el catálogo que el engine resuelve por id. Se relee con la
   *  fuente global. */
  systemPrompts: SystemPromptCatalog
  mcp: McpEntry[]
  mcpHost: Record<string, McpHostEntry>
  engine: EngineSection
  inbox: InboxSettings
  /** Los módulos de las actions globales. */
  actions: string[]
  /** La fuente global, releída de `runner.yaml` cuando cambia. */
  source: { spec: () => YamlSourceSpec; watch: string[] }
  /** Los agentes del asistente de la web, como los dejó la última lectura de la fuente global. */
  assistantAgents: () => AssistantAgent[]
  projects: ProjectConfig[]
  repos: RepoDef[]
}

function readYaml(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`${path}: no se pudo leer (${(err as Error).message})`)
  }
}

function parse<T>(path: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(readYaml(path))
  if (!parsed.success) throw new Error(`${path}: inválido\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

function parseBoard(url: string): { owner: string; number: number } {
  const match = url.match(/github\.com\/orgs\/([^/]+)\/projects\/(\d+)/) as RegExpMatchArray
  return { owner: match[1] as string, number: Number(match[2]) }
}

const list = <T>(entries: T | T[] | undefined): T[] => [entries ?? []].flat() as T[]

/** Un módulo de actions: un `.ts` que no es test ni declaración. */
const ACTION_MODULE = /^(?!.*\.(test|d)\.ts$).*\.ts$/

/** Los módulos de unas rutas de actions (archivos, directorios o globs). */
function actionFiles(paths: string | string[] | undefined, base: string, where: string): string[] {
  return list(paths).flatMap((ref) => {
    try {
      return expandPath(ref, base, ACTION_MODULE).filter((file) => ACTION_MODULE.test(file))
    } catch (err) {
      throw new Error(`${where}: actions: ${(err as Error).message}`)
    }
  })
}

/** El catálogo de repos: cada archivo trae una entrada o una lista; inline, una entrada. */
function readRepos(
  project: ProjectFile,
  base: string,
  where: string,
  projectId: string,
): RepoDef[] {
  const raw = list(project.repos).flatMap((entry) => {
    if (typeof entry !== 'string') return [{ where: `${where}: repos`, value: entry as unknown }]
    return expandPath(entry, base, /\.ya?ml$/).flatMap((path) =>
      [readYaml(path)].flat().map((value) => ({ where: path, value })),
    )
  })
  return raw.map(({ where: at, value }) => {
    const parsed = RepoDefSchema.safeParse(value)
    if (!parsed.success) throw new Error(`${at}: inválido\n${z.prettifyError(parsed.error)}`)
    return { ...parsed.data, projectId }
  })
}

/** La parte de fuente de un proyecto (o de `runner.yaml`): lo que lee el datasource. */
function sourceSpec(
  file: Pick<
    ProjectFile,
    'agents' | 'pipelines' | 'vars' | 'systemPrompts' | 'onError' | 'onInterrupt' | 'report'
  > & { capabilities?: Record<string, unknown> },
  base: string,
  origin: string,
): YamlSourceSpec {
  const defaults = Object.fromEntries(
    (['vars', 'systemPrompts', 'onError', 'onInterrupt', 'report', 'capabilities'] as const)
      .filter((key) => file[key] !== undefined)
      .map((key) => [key, file[key]]),
  )
  return {
    base,
    origin,
    source: defaults,
    ...(file.agents !== undefined ? { agents: file.agents } : {}),
    ...(file.pipelines !== undefined ? { pipelines: file.pipelines } : {}),
  }
}

/** Dónde está un proyecto: su `project.yaml`, o inline en `runner.yaml`. */
function locateProject(runnerPath: string, id: string, entry: string | ProjectFile) {
  const base = dirname(runnerPath)
  if (typeof entry !== 'string') {
    return { file: runnerPath, base, origin: `${runnerPath}: sources.projects.${id}`, inline: true }
  }
  const file = join(base, entry)
  return { file, base: dirname(file), origin: file, inline: false }
}

function readProject(runnerPath: string, id: string, entry: string | ProjectFile): ProjectConfig {
  const at = locateProject(runnerPath, id, entry)
  const read = (): ProjectFile => {
    if (!at.inline) return parse(at.file, ProjectFileSchema)
    const project = parse(runnerPath, RunnerFileSchema).sources.projects[id]
    if (!project || typeof project === 'string') throw new Error(`${at.origin}: ya no está inline`)
    return project
  }
  const project = read()
  return {
    id,
    dir: at.base,
    board: parseBoard(project.board),
    ...(project.branchPrefix ? { branchPrefix: project.branchPrefix } : {}),
    when: project.when ?? [],
    workingMarker:
      project.workingMarker === undefined ? DEFAULT_WORKING_MARKER : project.workingMarker,
    ...(project.maxConcurrent !== undefined ? { maxConcurrent: project.maxConcurrent } : {}),
    slackReview: {
      ...(project.slackReviewChannel ? { slackReviewChannel: project.slackReviewChannel } : {}),
      ...(project.slackReviewers ? { slackReviewers: project.slackReviewers } : {}),
      ...(project.slackReviewMessage ? { slackReviewMessage: project.slackReviewMessage } : {}),
    },
    repos: readRepos(project, at.base, at.origin, id),
    actions: actionFiles(project.actions, at.base, at.origin),
    source: { spec: () => sourceSpec(read(), at.base, at.origin), watch: [at.file] },
  }
}

/** `privateKeyPath` resuelto contra la carpeta de `runner.yaml` (o el home, con `~`). */
function withKeyPath(github: RunnerConfig['github'], dir: string): RunnerConfig['github'] {
  const path = github.privateKeyPath
  if (!path || isAbsolute(path)) return github
  const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(dir, path)
  return { ...github, privateKeyPath: resolved }
}

/** `engine.executions.path` resuelta: relativa a `runner.yaml`, o —sin ella y con `bun-sqlite`—
 *  la base de `IA_FLOW_HOME`. El runner nunca escribe al lado de su config por default. */
function withExecutionsPath(engine: EngineSection, dir: string): EngineSection {
  const executions = engine.executions
  if (executions?.driver !== 'bun-sqlite') return engine
  const path = executions.path
  const resolved =
    path === undefined
      ? defaultDatabasePath()
      : path === ':memory:' || isAbsolute(path)
        ? path
        : path.startsWith('~/')
          ? join(homedir(), path.slice(2))
          : resolve(dir, path)
  return { ...engine, executions: { ...executions, path: resolved } }
}

/** El `runner.yaml` a cargar: `path` si es un archivo (`runner.local.yaml`, el que sea), o
 *  `<path>/runner.yaml` si es una carpeta. */
export function runnerPathOf(path: string): string {
  return existsSync(path) && statSync(path).isFile() ? path : join(path, 'runner.yaml')
}

/** La config de un `runner.yaml` (o de la carpeta que lo tiene). Sus rutas relativas —agentes,
 *  pipelines, proyectos, el PEM, la base— se resuelven contra la carpeta del archivo. */
export function loadRunnerConfig(path: string): RunnerConfig {
  const runnerPath = runnerPathOf(path)
  const dir = dirname(runnerPath)
  const file = parse(runnerPath, RunnerFileSchema)
  const projects = Object.entries(file.sources.projects).map(([id, entry]) =>
    readProject(runnerPath, id, entry),
  )
  let prompts = promptsById(file.systemPrompts)
  let assistants = globalCapabilities(file.sources.capabilities).agents
  return {
    dir,
    runnerPath,
    settings: file.settings ?? {},
    github: withKeyPath(file.github ?? {}, dir),
    slack: { users: file.slack?.users ?? {} },
    providers: file.providers,
    host: file.host ?? {},
    systemPrompts: { resolve: (id) => prompts.get(id) },
    mcp: file.mcp,
    mcpHost: file.mcpHost,
    engine: withExecutionsPath(file.engine, dir),
    inbox: file.inbox,
    actions: actionFiles(file.sources.actions, dir, `${runnerPath}: sources`),
    source: {
      spec: () => {
        const reread = parse(runnerPath, RunnerFileSchema)
        const { agents, pipelines, capabilities } = reread.sources
        prompts = promptsById(reread.systemPrompts)
        const global = globalCapabilities(capabilities)
        assistants = global.agents
        // Las capacidades del runner (`capabilities/`) van con la fuente global: sus agentes como
        // documentos inline, y lo que `sources.capabilities` no declara, cumplido por ellos.
        return sourceSpec(
          {
            agents: [...list(agents), ...BUILTIN_CAPABILITY_AGENTS],
            ...(pipelines !== undefined ? { pipelines } : {}),
            capabilities: global.capabilities,
          },
          dir,
          `${runnerPath}: sources`,
        )
      },
      watch: [runnerPath],
    },
    assistantAgents: () => assistants,
    projects,
    repos: projects.flatMap((project) => project.repos),
  }
}

/** Las capacidades de la fuente global: las del runner, pisadas por las de `runner.yaml`, y los
 *  agentes del asistente que salen de ellas. Una entrada propia de un agente del asistente sin
 *  `label` conserva el de la del runner. */
function globalCapabilities(own: Record<string, Record<string, unknown>> | undefined) {
  const merged: Record<string, Record<string, unknown>> = { ...BUILTIN_CAPABILITIES }
  for (const [name, node] of Object.entries(own ?? {})) {
    const builtin = BUILTIN_CAPABILITIES[name]
    merged[name] =
      builtin && isAssistantCapability(name)
        ? { label: builtin.label, description: builtin.description, ...node }
        : node
  }
  return assistantAgents(merged)
}

function promptsById(entries: RunnerFile['systemPrompts']): Map<string, string> {
  return new Map(entries.map((entry) => [entry.id, entry.text]))
}

const TELEMETRY_ENV: Record<string, string> = {
  endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  serviceName: 'OTEL_SERVICE_NAME',
  environment: 'OTEL_DEPLOYMENT_ENVIRONMENT',
  logLevel: 'LOG_LEVEL',
}

const GITHUB_ENV: Record<string, string> = {
  mode: 'IA_FLOW_GITHUB_AUTH_MODE',
  appId: 'IA_FLOW_GITHUB_APP_ID',
  installationId: 'IA_FLOW_GITHUB_APP_INSTALLATION_ID',
  privateKeyPath: 'IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH',
  clientId: 'IA_FLOW_GITHUB_CLIENT_ID',
}

export interface RunnerEnvReport {
  applied: string[]
  overriddenByEnv: string[]
}

/** `github`, `settings.port` y `settings.telemetry` al env, salvo lo que el env ya trae. */
export function applyRunnerEnv(cfg: RunnerConfig): RunnerEnvReport {
  const applied: string[] = []
  const overriddenByEnv: string[] = []
  const put = (name: string, value: string) => {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      overriddenByEnv.push(name)
      return
    }
    process.env[name] = value
    applied.push(name)
  }
  for (const [key, value] of Object.entries(cfg.github)) {
    const name = GITHUB_ENV[key]
    if (name && value !== undefined) put(name, String(value))
  }
  for (const [key, value] of Object.entries(cfg.settings.telemetry ?? {})) {
    const name = TELEMETRY_ENV[key]
    if (name && value !== undefined) put(name, String(value))
  }
  if (cfg.settings.port !== undefined) put('IA_FLOW_SERVER_PORT', String(cfg.settings.port))
  // Resuelto, para que runner.yaml lo pueda nombrar (`${IA_FLOW_HOME}/memory.json` en un mcpHost).
  if (!process.env.IA_FLOW_HOME?.trim()) process.env.IA_FLOW_HOME = runnerHome()
  return { applied, overriddenByEnv }
}
