/**
 * Lo que el runner lee de `.config/`: `runner.yaml` es el índice de todo y nada se descubre por
 * carpeta — cada cosa se declara.
 *
 *   runner.yaml      scope runner: settings, identidad de GitHub, providers, MCP, `engine:` (cómo
 *                    corre el engine: `engine/mountEngine.ts`) y `sources:` (qué corre: la fuente
 *                    global —`agents`, `pipelines`—, las `actions` globales y los `projects`,
 *                    cada uno la ruta a su `project.yaml` o el proyecto inline)
 *   project.yaml     scope proyecto: board, prefijo de rama y label (el runner), los defaults de su
 *                    fuente (`systemPrompts`, `onError`, `onInterrupt`, `report`, `vars`), sus `agents`,
 *                    `pipelines`, `actions` y `repos`
 *
 * `agents`, `pipelines` y `repos` aceptan, solos o en lista: un directorio, un archivo, un glob en
 * el nombre del archivo (`./pipelines/1*.yaml`) o el documento inline; `actions` (código), sólo
 * rutas. Las rutas son relativas al archivo que las declara.
 *
 * Todo `.strict()`: una clave mal escrita rompe el arranque en vez de quedar como config que nadie
 * lee. `applyRunnerEnv` vuelca `github`/`settings` al env — **el env real gana**, así un PEM local
 * se apunta con IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH sin editar el archivo.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expandPath, type YamlSourceSpec } from '@ia-flow/agent-engine-datasource-yaml'
import type { SlackReviewConfig } from '@ia-flow/slack-api'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { EngineSection } from '../engine/mountEngine.js'

const McpEntrySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.strictObject({
    type: z.enum(['http', 'sse', 'stdio']),
    url: z.string().optional(),
    /** Con `${VAR}`: se resuelve del ambiente (y `${GITHUB_TOKEN}` es el token de la App). */
    authorizationToken: z.string().optional(),
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
  /** `task.branch` = `<branchPrefix><número>`. */
  branchPrefix: z.string().min(1).default('ia-flow/'),
  /** Sólo las cards con esta label son de este runner — para convivir con otro engine sobre el
   *  mismo board. Sin esto, todas las del board. */
  label: z.string().min(1).optional(),
  /** Cuántas corridas de sus tasks a la vez (debajo de `engine.executions.maxConcurrent`). */
  maxConcurrent: z.number().int().positive().optional(),
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
        })
        .optional(),
    })
    .optional(),
  github: z
    .strictObject({
      mode: z.enum(['auto', 'static', 'gh-cli', 'github-app']).optional(),
      appId: z.string().optional(),
      installationId: z.string().optional(),
      privateKeyPath: z.string().optional(),
    })
    .optional(),
  /** Los defaults de cada provider para todos sus agentes (`anthropic-api: { maxTokens, … }`). */
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  mcp: z.array(McpEntrySchema).default([]),
  /** Cómo corre el engine (`engine/mountEngine.ts`). */
  engine: EngineSection.default({}),
  /** Qué corre: la composición del runner, que el engine sólo ve como fuentes ya armadas. */
  sources: z
    .strictObject({
      /** La fuente global: la que recibe todos los eventos (ej. los webhooks crudos). */
      agents: Entries.optional(),
      pipelines: Entries.optional(),
      /** Quién cumple cada capacidad del engine (`whenText`, `fileFocus`): un paso de la fuente
       *  global, típicamente `{ agent: <id> }`. Sin una, esa capacidad está apagada. */
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
  branchPrefix: string
  /** Ver `label` en `project.yaml`. */
  label?: string
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
  providers: Record<string, Record<string, unknown>>
  mcp: McpEntry[]
  engine: EngineSection
  /** Los módulos de las actions globales. */
  actions: string[]
  /** La fuente global, releída de `runner.yaml` cuando cambia. */
  source: { spec: () => YamlSourceSpec; watch: string[] }
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
    branchPrefix: project.branchPrefix,
    ...(project.label ? { label: project.label } : {}),
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

export function loadRunnerConfig(dir: string): RunnerConfig {
  const runnerPath = join(dir, 'runner.yaml')
  const file = parse(runnerPath, RunnerFileSchema)
  const projects = Object.entries(file.sources.projects).map(([id, entry]) =>
    readProject(runnerPath, id, entry),
  )
  return {
    dir,
    runnerPath,
    settings: file.settings ?? {},
    github: file.github ?? {},
    providers: file.providers,
    mcp: file.mcp,
    engine: file.engine,
    actions: actionFiles(file.sources.actions, dir, `${runnerPath}: sources`),
    source: {
      spec: () => {
        const { agents, pipelines, capabilities } = parse(runnerPath, RunnerFileSchema).sources
        return sourceSpec(
          {
            ...(agents !== undefined ? { agents } : {}),
            ...(pipelines !== undefined ? { pipelines } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          },
          dir,
          `${runnerPath}: sources`,
        )
      },
      watch: [runnerPath],
    },
    projects,
    repos: projects.flatMap((project) => project.repos),
  }
}

const TELEMETRY_ENV: Record<string, string> = {
  endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  serviceName: 'OTEL_SERVICE_NAME',
  environment: 'OTEL_DEPLOYMENT_ENVIRONMENT',
}

const GITHUB_ENV: Record<string, string> = {
  mode: 'IA_FLOW_GITHUB_AUTH_MODE',
  appId: 'IA_FLOW_GITHUB_APP_ID',
  installationId: 'IA_FLOW_GITHUB_APP_INSTALLATION_ID',
  privateKeyPath: 'IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH',
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
  return { applied, overriddenByEnv }
}
