import type { Database } from 'bun:sqlite'
import type { IEnvVarRepository } from '../../../domain/ports/IEnvVarRepository.js'

export class SqliteEnvVarRepository implements IEnvVarRepository {
  /**
   * Clave → el valor que el AMBIENTE traía antes de que la DB lo tapara.
   *
   * Guarda TODAS las que taparon algo, incluso cuando el valor era idéntico.
   * Son dos preguntas distintas y confundirlas fue un bug: qué restituir al
   * borrar (todo lo que había) no es lo mismo que qué avisarle al operador
   * (sólo lo que difiere). Con una sola condición, un compose que repetía el
   * mismo token que estaba guardado no entraba al mapa, y borrar la fila desde
   * la pantalla dejaba al proceso sin ningún valor — justo el caso que
   * `delete` existe para evitar. El cartel se deriva filtrando en
   * `shadowedEnvKeys`.
   */
  #ambient = new Map<string, string>()

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
    // override. Si no se anotara acá, el cartel diría "guardada" hasta el
    // próximo reinicio y "sobrescribe el entorno" después — el mismo estado
    // contado de dos formas distintas es peor que no contarlo.
    //
    // El `get(key) === null` NO es una optimización: sin él, el segundo
    // guardado de la misma clave se anota solo. Para entonces `Bun.env[key]`
    // ya es el valor que ESTE repositorio escribió en el guardado anterior, no
    // el del ambiente, así que la pantalla terminaría avisando de un entorno
    // que nunca existió. Sólo la PRIMERA vez que una fila tapa algo hay un
    // ambiente que tapar.
    const previous = Bun.env[key]
    if (this.get(key) === null && previous !== undefined) this.#ambient.set(key, previous)
    this.db.run(
      `INSERT INTO global_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`env.${key}`, value],
    )
    ;(Bun.env as Record<string, string>)[key] = value
  }

  delete(key: string): void {
    this.db.run('DELETE FROM global_settings WHERE key = ?', [`env.${key}`])
    // Sin fila guardada, manda el ambiente otra vez — y eso incluye
    // RESTITUIRLO en el proceso, no sólo dejar de reportarlo. Borrar a secas
    // destruía el valor que traía el shell o el compose: la variable quedaba
    // sin ningún valor hasta reiniciar, mientras la pantalla la mostraba como
    // "no configurada" aunque el deploy sí la tuviera.
    const ambient = this.#ambient.get(key)
    if (ambient !== undefined) {
      ;(Bun.env as Record<string, string>)[key] = ambient
      this.#ambient.delete(key)
      return
    }
    delete (Bun.env as Record<string, string | undefined>)[key]
  }

  loadIntoProcess(): void {
    const rows = this.db
      .query("SELECT key, value FROM global_settings WHERE key LIKE 'env.%'")
      .all() as { key: string; value: string }[]
    const ambient = new Map<string, string>()
    for (const { key, value } of rows) {
      const envKey = key.slice(4) // strip "env." prefix
      // Se anota ANTES de escribir: un instante después `Bun.env[envKey]` ya
      // es el valor de la DB y la pregunta deja de tener respuesta.
      const previous = Bun.env[envKey]
      if (previous !== undefined) ambient.set(envKey, previous)
      ;(Bun.env as Record<string, string>)[envKey] = value
    }
    // Reemplaza en vez de acumular: un segundo `loadIntoProcess` (tests, un
    // reload) describe el estado de ESA corrida, no la unión de todas.
    this.#ambient = ambient
  }

  shadowedEnvKeys(): string[] {
    // Acá sí importa la diferencia: que el compose repita el mismo token que
    // está guardado no es un override que valga la pena mostrarle a nadie —
    // sería ruido en toda la pantalla. Pero el valor sigue en `#ambient` para
    // que `delete` pueda devolverlo.
    return [...this.#ambient]
      .filter(([key, previous]) => this.get(key) !== previous)
      .map(([key]) => key)
  }
}
