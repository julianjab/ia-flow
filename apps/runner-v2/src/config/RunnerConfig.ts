/**
 * Lo que el runner lee de `.config/` además del engine (que lee `engine.yaml` y `projects/` por su
 * cuenta, con `@ia-tools/agent-pipeline-yaml`):
 *
 *   runner.yaml                    settings, identidad de GitHub, providers, MCP y el board de
 *                                  cada proyecto
 *   projects/<id>/repos/*.yaml     el catálogo de repos de cada proyecto
 *
 * Todo `.strict()`: una clave mal escrita rompe el arranque en vez de quedar como config que nadie
 * lee. `applyRunnerEnv` vuelca `github`/`settings` al env — **el env real gana**, así un PEM local
 * se apunta con IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH sin editar el archivo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

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

const ProjectSettingsSchema = z.strictObject({
  /** El GitHub Project v2 del proyecto: `https://github.com/orgs/<org>/projects/<n>`. */
  board: z.string().regex(/github\.com\/orgs\/[^/]+\/projects\/\d+/, 'un GitHub Project v2 de org'),
  /** `task.branch` = `<branchPrefix><número>`. */
  branchPrefix: z.string().min(1).default('ia-flow/'),
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
  projects: z.record(z.string(), ProjectSettingsSchema),
})

export const RepoDefSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
})
export type RepoDef = z.infer<typeof RepoDefSchema> & { projectId: string }

export interface ProjectSettings {
  id: string
  board: { owner: string; number: number }
  branchPrefix: string
  repos: RepoDef[]
}

export interface RunnerConfig {
  /** La carpeta de la definición (`.config`). */
  dir: string
  enginePath: string
  settings: NonNullable<z.infer<typeof RunnerFileSchema>['settings']>
  github: NonNullable<z.infer<typeof RunnerFileSchema>['github']>
  providers: Record<string, Record<string, unknown>>
  mcp: McpEntry[]
  projects: ProjectSettings[]
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
function readRepos(dir: string, projectId: string): RepoDef[] {
  const reposDir = join(dir, 'projects', projectId, 'repos')
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

export function loadRunnerConfig(dir: string): RunnerConfig {
  const runnerPath = join(dir, 'runner.yaml')
  const enginePath = join(dir, 'engine.yaml')
  if (!existsSync(enginePath)) throw new Error(`${dir}: falta engine.yaml`)
  const parsed = RunnerFileSchema.safeParse(readYaml(runnerPath))
  if (!parsed.success) throw new Error(`${runnerPath}: inválido\n${z.prettifyError(parsed.error)}`)
  const file = parsed.data
  // Cada proyecto de projects/ necesita su board acá: sin él no hay dónde leer ni escribir.
  const folders = existsSync(join(dir, 'projects'))
    ? readdirSync(join(dir, 'projects'), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && existsSync(join(dir, 'projects', entry.name, 'project.yaml')),
        )
        .map((entry) => entry.name)
    : []
  const missing = folders.filter((id) => !(id in file.projects))
  if (missing.length > 0) {
    throw new Error(
      `${runnerPath}: falta el board de ${missing.map((id) => `projects.${id}`).join(', ')}`,
    )
  }
  const projects = Object.entries(file.projects).map(([id, settings]) => {
    if (!existsSync(join(dir, 'projects', id))) {
      throw new Error(`${runnerPath}: projects.${id} no tiene carpeta en projects/${id}/`)
    }
    return {
      id,
      board: parseBoard(settings.board),
      branchPrefix: settings.branchPrefix,
      repos: readRepos(dir, id),
    }
  })
  return {
    dir,
    enginePath,
    settings: file.settings ?? {},
    github: file.github ?? {},
    providers: file.providers,
    mcp: file.mcp,
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
