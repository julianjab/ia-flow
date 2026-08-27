import type { Database } from 'bun:sqlite'
import type { IEnvVarRepository } from '../../../domain/ports/IEnvVarRepository.js'

export class SqliteEnvVarRepository implements IEnvVarRepository {
  /** Ver `shadowedEnvKeys` en el port: se llena en `loadIntoProcess`, que es
   *  el único instante en que todavía se puede saber qué había antes. */
  #shadowed: string[] = []

  constructor(private db: Database) {}

  get(key: string): string | null {
    const row = this.db
      .query('SELECT value FROM global_settings WHERE key = ?')
      .get(`env.${key}`) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    // Mismo registro que en `loadIntoProcess`, y por el mismo motivo: guardar
    // desde la pantalla una clave que hoy viene del ambiente TAMBIÉN es un
    // override, y el llamador está por pisar `Bun.env` con el valor nuevo. Si
    // no se anota acá, el cartel diría "guardado" hasta el próximo reinicio y
    // "sobrescribe el entorno" después — el mismo estado contado de dos
    // formas distintas es peor que no contarlo.
    const previous = Bun.env[key]
    if (previous !== undefined && previous !== value && !this.#shadowed.includes(key)) {
      this.#shadowed.push(key)
    }
    this.db.run(
      `INSERT INTO global_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`env.${key}`, value],
    )
  }

  delete(key: string): void {
    // Sin fila guardada no hay nada que sobrescriba: si el ambiente todavía
    // trae un valor, vuelve a ser él el que manda.
    this.#shadowed = this.#shadowed.filter((k) => k !== key)
    this.db.run('DELETE FROM global_settings WHERE key = ?', [`env.${key}`])
  }

  loadIntoProcess(): void {
    const rows = this.db
      .query("SELECT key, value FROM global_settings WHERE key LIKE 'env.%'")
      .all() as { key: string; value: string }[]
    const shadowed: string[] = []
    for (const { key, value } of rows) {
      const envKey = key.slice(4) // strip "env." prefix
      // Se anota ANTES de escribir: un instante después `Bun.env[envKey]` ya
      // es el valor de la DB y la pregunta deja de tener respuesta. Sólo
      // cuenta si el valor previo era DISTINTO — que el compose repita el
      // mismo token que está guardado no es un override que valga la pena
      // mostrarle a nadie.
      const previous = Bun.env[envKey]
      if (previous !== undefined && previous !== value) shadowed.push(envKey)
      ;(Bun.env as Record<string, string>)[envKey] = value
    }
    // Reemplaza en vez de acumular: un segundo `loadIntoProcess` (tests, un
    // reload) describe el estado de ESA corrida, no la unión de todas.
    this.#shadowed = shadowed
  }

  shadowedEnvKeys(): string[] {
    return [...this.#shadowed]
  }
}
