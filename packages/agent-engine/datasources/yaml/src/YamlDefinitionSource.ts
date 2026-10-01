import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { substituteVars } from '@ia-flow/agent-engine'
import {
  AgentDoc,
  type DefinitionSource,
  type Located,
  PipelineDoc,
  SourceDoc,
  type SourceDocs,
} from '@ia-flow/agent-engine-definitions'
import { z } from 'zod'
import { expandPath, signature } from './paths.js'
import { YamlReader } from './YamlReader.js'

const YAML = /\.ya?ml$/

/** Una entrada: la ruta a un archivo, un directorio o un glob (`./pipelines/*.yaml`) — relativa a
 *  `base` —, o el documento inline. */
export type YamlEntry = string | Record<string, unknown>
/** Una entrada sola o una lista. */
export type YamlEntries = YamlEntry | YamlEntry[]

/** Qué documentos forman una fuente, declarados en un índice (ej. el `runner.yaml` de una app). */
export interface YamlSourceSpec {
  /** Contra qué se resuelven las rutas (la carpeta del índice). */
  base: string
  /** Dónde se declaró (para los errores de un documento inline). Default: `base`. */
  origin?: string
  /** Los defaults de la fuente: un archivo o inline. */
  source?: YamlEntry
  agents?: YamlEntries
  pipelines?: YamlEntries
}

export type YamlDefinitionSourceOptions = {
  /** Su id; si no, el de su `source`, y si no, el nombre de `base`. */
  id?: string
  /** `vars` además de las de `source`, que ganan. Se sustituyen al leer: `{{vars.x}}`. */
  vars?: Record<string, unknown>
} & (
  | {
      /** El layout de carpeta: `source.yaml`, `agents/` y `pipelines/` dentro de `dir`. */
      dir: string
    }
  | {
      /** Las entradas; una función se vuelve a leer cuando cambia algún archivo de `watch`. */
      spec: YamlSourceSpec | (() => YamlSourceSpec)
      /** El índice que declara `spec`: si cambia, se vuelve a leer y la fuente se recarga. */
      watch?: string[]
    }
)

/** Lo que se lee de `source` antes de sustituir nada: su id y sus vars. */
const SourceVarsDoc = z.looseObject({
  id: z.string().min(1).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
})

/** El archivo de `source`, si es una ruta: uno solo — una carpeta o un glob que no dan
 *  exactamente un archivo rompen la lectura en vez de elegir uno. */
function sourceFile(spec: YamlSourceSpec): string | undefined {
  if (typeof spec.source !== 'string') return undefined
  const [path, ...rest] = expandPath(spec.source, spec.base, YAML)
  if (!path || rest.length > 0) {
    throw new Error(`${spec.source}: source tiene que ser un único archivo`)
  }
  return path
}

/** El layout de carpeta como spec: lo que haya de `source.yaml`, `agents/` y `pipelines/`. */
function folderSpec(dir: string): YamlSourceSpec {
  const has = (name: string) => existsSync(join(dir, name))
  return {
    base: dir,
    ...(has('source.yaml') ? { source: 'source.yaml' } : {}),
    ...(has('agents') ? { agents: 'agents' } : {}),
    ...(has('pipelines') ? { pipelines: 'pipelines' } : {}),
  }
}

/**
 * Una fuente en YAML traducida a definiciones (`SourceDocs`): nada más. Armarlas es de
 * `@ia-flow/agent-engine-definitions` (`DefinitionPipelineSource`).
 *
 * Sus documentos se declaran en un `spec` —cada lista acepta un directorio, un archivo, un glob o
 * el documento inline, sola o en lista— o con el layout de carpeta (`dir`):
 *
 * ```
 * <dir>/
 *   source.yaml         id, vars, systemPrompts, onError, report   (opcional)
 *   agents/*.yaml       un agente por archivo
 *   pipelines/*.yaml    una pipeline por archivo, en orden de nombre
 * ```
 *
 * Las `vars` se sustituyen en el YAML crudo de todos los documentos, antes de validarlos: el schema
 * valida el valor real y no `'{{vars.x}}'`, y una var que no existe rompe la lectura.
 */
export class YamlDefinitionSource implements DefinitionSource {
  private readonly reader = new YamlReader()
  private cached?: { watched: string; spec: YamlSourceSpec }

  constructor(private readonly options: YamlDefinitionSourceOptions) {}

  /** Una fuente por cada subcarpeta de `root` con `source.yaml` o `pipelines/`. */
  static fromRoot(root: string): YamlDefinitionSource[] {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (existsSync(join(root, entry.name, 'source.yaml')) ||
            existsSync(join(root, entry.name, 'pipelines'))),
      )
      .map((entry) => entry.name)
      .sort()
      .map((name) => new YamlDefinitionSource({ dir: join(root, name) }))
  }

  /** El spec vigente: el de carpeta se recalcula (una carpeta nueva cuenta), el de una función
   *  se vuelve a pedir sólo si cambió el índice que la declara. */
  private spec(): YamlSourceSpec {
    const { options } = this
    if ('dir' in options) {
      if (!existsSync(options.dir))
        throw new Error(`${options.dir}: no es la carpeta de una fuente`)
      return folderSpec(options.dir)
    }
    if (typeof options.spec !== 'function') return options.spec
    const watched = signature(options.watch ?? [])
    if (this.cached?.watched !== watched) this.cached = { watched, spec: options.spec() }
    return this.cached.spec
  }

  /** Los archivos de una lista de entradas (las inline no tienen). */
  private files(entries: YamlEntries | undefined, base: string): string[] {
    return [entries ?? []]
      .flat()
      .flatMap((entry) => (typeof entry === 'string' ? expandPath(entry, base, YAML) : []))
  }

  /** Cambia si cambió el índice o cualquier archivo que declara (o se agregó o sacó uno). */
  version(): string {
    const watched = 'dir' in this.options ? '' : signature(this.options.watch ?? [])
    try {
      const spec = this.spec()
      const own = sourceFile(spec)
      return `${watched}#${signature([
        ...(own ? [own] : []),
        ...this.files(spec.agents, spec.base),
        ...this.files(spec.pipelines, spec.base),
      ])}`
    } catch (error) {
      // Un índice o una referencia rota: `read()` dice por qué, y la fuente sigue la anterior.
      return `${watched}#roto:${(error as Error).message}`
    }
  }

  read(): SourceDocs {
    const spec = this.spec()
    const origin = spec.origin ?? spec.base
    const sourcePath = sourceFile(spec)
    const declared = sourcePath
      ? this.reader.read(sourcePath, SourceVarsDoc)
      : this.reader.parse(`${origin}: source`, spec.source ?? {}, SourceVarsDoc)
    const vars = { ...this.options.vars, ...declared.vars }
    const substitute = (where: string) => (raw: unknown) => substituteVars(raw, vars, where)

    const docs = <T>(entries: YamlEntries | undefined, field: string, schema: z.ZodType<T>) =>
      [entries ?? []].flat().flatMap((entry, i): Located<T>[] =>
        typeof entry === 'string'
          ? expandPath(entry, spec.base, YAML).map((path) => ({
              path,
              doc: this.reader.read(path, schema, substitute(path)),
            }))
          : [
              {
                path: `${origin}: ${field}[${i}]`,
                doc: this.reader.parse(
                  `${origin}: ${field}[${i}]`,
                  entry,
                  schema,
                  substitute(origin),
                ),
              },
            ],
      )

    const source: Located<SourceDoc> = sourcePath
      ? { path: sourcePath, doc: this.reader.read(sourcePath, SourceDoc, substitute(sourcePath)) }
      : {
          path: `${origin}: source`,
          doc: this.reader.parse(
            `${origin}: source`,
            spec.source ?? {},
            SourceDoc,
            substitute(origin),
          ),
        }
    return {
      id: this.options.id ?? declared.id ?? basename(spec.base),
      source,
      agents: docs(spec.agents, 'agents', AgentDoc),
      pipelines: docs(spec.pipelines, 'pipelines', PipelineDoc),
    }
  }
}
