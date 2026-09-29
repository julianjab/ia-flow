/**
 * Lo que el runner lee de `.config/`, un archivo por scope:
 *
 *   runner.yaml                    scope runner: settings, identidad de GitHub, providers, MCP y
 *                                  `engine:` (cómo se arma el engine: `engine/mountEngine.ts`)
 *   projects/<id>/project.yaml     scope proyecto: su board, el prefijo de rama y su label
 *   projects/<id>/repos/*.yaml     el catálogo de repos de cada proyecto
 *
 * Los agentes y pipelines de cada scope los lee el engine (`source.yaml`, `agents/`, `pipelines/`).
 *
 * Todo `.strict()`: una clave mal escrita rompe el arranque en vez de quedar como config que nadie
 * lee. `applyRunnerEnv` vuelca `github`/`settings` al env — **el env real gana**, así un PEM local
 * se apunta con IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH sin editar el archivo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** `projects/<id>/project.yaml`: lo que el runner sabe de un proyecto. */
export const ProjectFileSchema = z.strictObject({
  /** El GitHub Project v2 del proyecto: `https://github.com/orgs/<org>/projects/<n>`. */
  board: z.string().regex(/github\.com\/orgs\/[^/]+\/projects\/\d+/, 'un GitHub Project v2 de org'),
  /** `task.branch` = `<branchPrefix><número>`. */
  branchPrefix: z.string().min(1).default('ia-flow/'),
  /** Sólo las cards con esta label son de este runner — para convivir con otro engine sobre el
   *  mismo board. Sin esto, todas las del board. */
  label: z.string().min(1).optional(),
})

export const RunnerFileSchema = z.strictObject({
  settings: z.strictObject({ port: z.number().int().positive().optional() }).optional(),
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
  /** Cómo se arma el engine (`engine/mountEngine.ts`). */
  engine: EngineSection.default({}),
})

export const RepoDefSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
})
export type RepoDef = z.infer<typeof RepoDefSchema> & { projectId: string }

/** Un proyecto: su carpeta (`projects/<id>/`), su `project.yaml` y su catálogo de repos. */
export interface ProjectConfig {
  id: string
  dir: string
  board: { owner: string; number: number }
  branchPrefix: string
  /** Ver `label` en `project.yaml`. */
  label?: string
  repos: RepoDef[]
}

export interface RunnerConfig {
  /** La carpeta de la definición (`.config`). */
  dir: string
  /** `runner.yaml`: también la config del engine, en su sección `engine:`. */
  runnerPath: string
  settings: NonNullable<z.infer<typeof RunnerFileSchema>['settings']>
  github: NonNullable<z.infer<typeof RunnerFileSchema>['github']>
  providers: Record<string, Record<string, unknown>>
  mcp: McpEntry[]
  engine: EngineSection
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

function parseBoard(url: string): { owner: string; number: number } {
  const match = url.match(/github\.com\/orgs\/([^/]+)\/projects\/(\d+)/) as RegExpMatchArray
  return { owner: match[1] as string, number: Number(match[2]) }
}

/** `projects/<id>/repos/*.yaml`: una entrada suelta o una lista por archivo. */
function readRepos(projectDir: string, projectId: string): RepoDef[] {
  const reposDir = join(projectDir, 'repos')
  if (!existsSync(reposDir)) return []
  return readdirSync(reposDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) => {
      const path = join(reposDir, name)
      const parsed = z.array(RepoDefSchema).safeParse([readYaml(path)].flat())
      if (!parsed.success) throw new Error(`${path}: inválido\n${z.prettifyError(parsed.error)}`)
      return parsed.data.map((repo) => ({ ...repo, projectId }))
    })
}

function parse<T>(path: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(readYaml(path))
  if (!parsed.success) throw new Error(`${path}: inválido\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** Un proyecto por subcarpeta de `projects/` con `project.yaml`. */
function readProjects(dir: string): ProjectConfig[] {
  const root = join(dir, 'projects')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'project.yaml')))
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const projectDir = join(root, id)
      const file = parse(join(projectDir, 'project.yaml'), ProjectFileSchema)
      return {
        id,
        dir: projectDir,
        board: parseBoard(file.board),
        branchPrefix: file.branchPrefix,
        ...(file.label ? { label: file.label } : {}),
        repos: readRepos(projectDir, id),
      }
    })
}

export function loadRunnerConfig(dir: string): RunnerConfig {
  const runnerPath = join(dir, 'runner.yaml')
  const file = parse(runnerPath, RunnerFileSchema)
  const projects = readProjects(dir)
  return {
    dir,
    runnerPath,
    settings: file.settings ?? {},
    github: file.github ?? {},
    providers: file.providers,
    mcp: file.mcp,
    engine: file.engine,
    projects,
    repos: projects.flatMap((project) => project.repos),
  }
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

/** `github` y `settings.port` al env, salvo lo que el env ya trae. */
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
  if (cfg.settings.port !== undefined) put('IA_FLOW_SERVER_PORT', String(cfg.settings.port))
  return { applied, overriddenByEnv }
}
