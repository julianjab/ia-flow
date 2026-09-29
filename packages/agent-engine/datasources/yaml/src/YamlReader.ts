import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

/** Lee un archivo YAML (o toma un documento inline) y lo valida contra su schema; los errores dicen
 *  dónde y qué campo.
 *  `transform` corre sobre el documento crudo, ANTES de validar (ej. sustituir las `vars`). */
export class YamlReader {
  read<T>(path: string, schema: z.ZodType<T>, transform?: (raw: unknown) => unknown): T {
    let raw: unknown
    try {
      raw = parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`${path}: no es YAML válido (${(error as Error).message})`)
    }
    return this.parse(path, raw, schema, transform)
  }

  /** Un documento ya leído (ej. inline en un índice), validado igual; `where` dice dónde está. */
  parse<T>(
    where: string,
    raw: unknown,
    schema: z.ZodType<T>,
    transform?: (raw: unknown) => unknown,
  ): T {
    const parsed = schema.safeParse((transform ? transform(raw ?? {}) : raw) ?? {})
    if (!parsed.success) throw new Error(`${where}: inválido\n${z.prettifyError(parsed.error)}`)
    return parsed.data
  }
}
