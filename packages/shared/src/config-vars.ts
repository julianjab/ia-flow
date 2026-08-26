// Contrato de "qué se puede configurar en este proceso".
//
// El catálogo de variables vivía como un `const` de 21 entradas dentro de
// `routes/env-vars.ts` — una ruta HTTP guardando datos de dominio, y una lista
// que había que acordarse de actualizar a mano cada vez que un módulo nuevo
// leía un `process.env`. El CLAUDE.md de `github-auth` tiene la regla escrita
// ("Config nueva → variable en ENV_VAR_DEFINITIONS"), y una regla que hay que
// recordar es una regla que se va a olvidar.
//
// Acá la declaración se muda **al lado del código que lee la variable**, y el
// composition root junta lo que encuentre. Dos consecuencias que son el punto
// de todo esto:
//
//   · Un proceso muestra sólo lo que realmente usa. El flavor `runner` no
//     registra tmux/iterm, así que sus knobs no aparecen.
//   · La respuesta puede depender de la config actual. En modo `github-app`
//     no tiene sentido pedir un PAT, y quien lo sabe es la estrategia de
//     credenciales ya resuelta — no una lista constante.
import { z } from 'zod'

export const ConfigVarKindSchema = z.enum(['password', 'text', 'select'])
export type ConfigVarKind = z.infer<typeof ConfigVarKindSchema>

export const ConfigVarGroupSchema = z.enum([
  'anthropic',
  'github',
  'slack',
  'daemon',
  'providers',
  'server',
])
export type ConfigVarGroup = z.infer<typeof ConfigVarGroupSchema>

export const ConfigVarDefSchema = z.object({
  /** El nombre de la env var. Es la clave: dos declarantes del mismo nombre
   *  son el mismo knob, y el composition root los dedupea. */
  name: z.string().min(1),
  label: z.string(),
  description: z.string(),
  kind: ConfigVarKindSchema.default('text'),
  group: ConfigVarGroupSchema,
  /** Enmascarar el valor en la UI y no devolverlo nunca por la API. */
  secret: z.boolean().default(false),
  /** Sólo `kind: 'select'`. */
  options: z.string().array().optional(),
  /** Qué pasa si no se setea. Documental; el default real vive en el módulo
   *  que la lee, y duplicarlo acá los desincronizaría. */
  fallback: z.string().optional(),
})

export type ConfigVarDef = z.infer<typeof ConfigVarDefSchema>

/**
 * Lo que implementa quien es dueño de una variable.
 *
 * **Opcional, no un port.** Es el mismo idioma que `canAccept?` y
 * `prepareWorkspace?` en `IAgentProvider`: el que sabe declara, el que no
 * calla. Obligar a cada implementación de cada port a cargar metadata de UI
 * ensancharía contratos que el CLAUDE.md pide mantener angostos, y la mitad de
 * las variables (`IA_FLOW_POLL_INTERVAL_MS`, `LOG_LEVEL`) no son de ninguna
 * clase: las declara su módulo con una constante al lado del `process.env[...]`
 * que las lee.
 *
 * Es una **función y no un array** porque la respuesta depende del estado: la
 * estrategia de credenciales pide `GITHUB_TOKEN` en modo `static` y
 * `IA_FLOW_GITHUB_APP_ID` + el PEM en modo `github-app`. Un array constante
 * seguiría ofreciendo el PAT donde no se usa, que es justo lo que esto viene a
 * arreglar.
 */
export interface ConfigurableComponent {
  describeConfig?(): ConfigVarDef[]
}

/**
 * Junta declaraciones de varias fuentes en un catálogo, respetando el orden de
 * llegada (que es el orden en la UI) y quedándose con la PRIMERA declaración de
 * cada nombre.
 *
 * Primera y no última: el composition root pasa lo más específico adelante (la
 * estrategia de credenciales ya resuelta) y lo genérico atrás, así que una
 * descripción contextual le gana a la de catálogo.
 */
export function mergeConfigVars(...sources: (ConfigVarDef[] | undefined)[]): ConfigVarDef[] {
  const seen = new Map<string, ConfigVarDef>()
  for (const source of sources) {
    for (const def of source ?? []) {
      if (!seen.has(def.name)) seen.set(def.name, def)
    }
  }
  return [...seen.values()]
}
