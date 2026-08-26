// Contrato de credenciales para integraciones externas (GitHub hoy; Linear /
// Slack el día que las tengan). Contract-only: acá NO hay I/O ni firma de
// nada — las implementaciones viven en el paquete que las usa
// (`@ia-flow/github-auth` para GitHub, ver el README de ese paquete para el
// porqué de que no estén en `issue-sources`).
//
// El valor de tener la *forma* acá no es polimorfismo — ningún consumidor va
// a pedir "un token" sin saber de qué servicio. Es que el modo sea un dato
// editable desde la web y auditable en los logs con la misma pinta para todos
// los servicios.

import { z } from 'zod'

/** Quién es el portador del token. Para logs, UI y debugging de atribución
 *  — nunca para ramificar lógica de negocio. */
export interface CredentialDescription {
  /** Estrategia efectiva ya resuelta (`auto` nunca aparece acá). */
  mode: string
  /** Identidad legible si la estrategia la conoce: `ia-flow[bot]`, un login,
   *  el App ID. `undefined` cuando la estrategia no puede saberlo sin gastar
   *  una llamada a la API. */
  identity?: string
}

export interface ICredentialProvider {
  /**
   * Token válido **ahora**. Cada implementación decide si eso significa
   * devolver una constante o renovar contra el upstream; el consumidor nunca
   * cachea el resultado — llama de nuevo la próxima vez que lo necesita.
   *
   * `undefined` es un valor legítimo, no un error: un clone de repo público
   * no necesita token, y el caller decide si eso lo bloquea.
   *
   * `scope` es opcional y hoy sólo lo mira la estrategia de GitHub App con
   * múltiples instalaciones. Está en la firma desde el principio para no
   * tener que romperla cuando eso llegue.
   */
  getToken(scope?: { owner?: string; repo?: string }): Promise<string | undefined>
  describe(): CredentialDescription
}

// ─── Config de auth de GitHub ───────────────────────────────────────────────
// Vive en shared (y no en el paquete de implementación) porque la edita la
// web: es la regla de "todo tipo que cruza la frontera server↔web".

export const GITHUB_AUTH_MODES = ['auto', 'static', 'gh-cli', 'github-app'] as const
export type GitHubAuthMode = (typeof GITHUB_AUTH_MODES)[number]

export const GitHubAuthConfigSchema = z.object({
  /**
   * `auto` prueba github-app → gh-cli → static y se queda con la primera
   * estrategia **configurada**. Es el default porque es lo que hace que esto
   * no rompa a nadie, pero la estrategia que gana se loguea al boot y se
   * expone en `describe()`: una cadena silenciosa deja sin respuesta la
   * pregunta "¿con qué identidad se escribió este comentario?".
   */
  mode: z.enum(GITHUB_AUTH_MODES).default('auto'),
  /** Modo `static`: PAT de toda la vida. */
  token: z.string().optional(),
  /** Modo `github-app`. `privateKey` acepta el PEM crudo o en base64. */
  appId: z.string().optional(),
  privateKey: z.string().optional(),
  installationId: z.string().optional(),
})

export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>
