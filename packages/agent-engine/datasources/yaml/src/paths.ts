import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const GLOB = /[*?]/

/** `*` (lo que sea salvo `/`) y `?` (un carácter) de un nombre de archivo, como regex. */
function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
}

/**
 * Los archivos de una referencia, relativa a `base`: un archivo, un directorio (sus archivos que
 * cumplen `accept`, en orden de nombre, sin entrar a subcarpetas) o un glob en el nombre
 * (`./pipelines/1*.yaml`). Una referencia que no existe tira: un typo no se ignora.
 */
export function expandPath(ref: string, base: string, accept: RegExp): string[] {
  const path = resolve(base, ref)
  const name = basename(path)
  if (GLOB.test(name)) {
    const dir = dirname(path)
    if (GLOB.test(dir)) throw new Error(`${ref}: el glob sólo puede ir en el nombre del archivo`)
    if (!existsSync(dir)) throw new Error(`${ref}: no existe ${dir}`)
    const matches = globRegex(name)
    return readdirSync(dir)
      .filter((file) => matches.test(file))
      .map((file) => join(dir, file))
      .filter((file) => statSync(file).isFile())
      .sort()
  }
  if (!existsSync(path)) throw new Error(`${ref}: no existe ${path}`)
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((file) => accept.test(file))
    .map((file) => join(path, file))
    .filter((file) => statSync(file).isFile())
    .sort()
}

/** La firma de unos archivos: cambia si cambia la fecha o el tamaño de alguno. */
export function signature(paths: string[]): string {
  return paths
    .map((path) => {
      if (!existsSync(path)) return `${path}:-`
      const { mtimeMs, size } = statSync(path)
      return `${path}:${mtimeMs}:${size}`
    })
    .join('|')
}
