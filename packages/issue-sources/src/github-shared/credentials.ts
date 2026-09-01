import type { CredentialDescription, ICredentialProvider } from '@ia-flow/shared'

// Misma indirección que `logger.ts`: este paquete no puede depender de
// `@ia-flow/github-auth` (sería atarle a `issue-sources` una estrategia de
// credenciales que también usan `workspace` y el agent-host, ninguno de los
// cuales tiene nada que ver con issues). El host cablea la implementación una
// vez en su composition root y `gql`/`rest` siguen sin saber de dónde sale el
// token.
let provider: ICredentialProvider | null = null

/** Llamado una vez al boot por el composition root de la app host. */
export function setGitHubCredentials(p: ICredentialProvider): void {
  provider = p
}

/**
 * Token para la próxima llamada. Se resuelve **por request**, no al boot: un
 * installation token de GitHub App vive una hora y el daemon corre días, así
 * que capturarlo una vez en una constante es exactamente el bug que este
 * indirección existe para evitar.
 *
 * Sin host cableado cae a `GITHUB_TOKEN` — que es el comportamiento histórico
 * y lo que mantiene a los tests del paquete andando sin ceremonia.
 */
export async function getGitHubToken(scope?: {
  owner?: string
  repo?: string
}): Promise<string | undefined> {
  if (provider) return provider.getToken(scope)
  return Bun.env.GITHUB_TOKEN || undefined
}

/**
 * Con qué estrategia se está autenticando el proceso, o `null` si el host no
 * cableó ninguna. No es telemetría: hay endpoints de la REST que existen para
 * una identidad y no para otra —`/user` es del usuario, y un installation
 * token de GitHub App no lo puede llamar—, así que quien elige el endpoint
 * necesita saber con qué identidad va a pegarle.
 *
 * Es **async** y no un pasamanos a `describe()` por una razón concreta: el
 * provider que cablea el server es `lazyGitHubCredentials`, que no resuelve su
 * estrategia hasta el primer `getToken()` y hasta entonces se describe como
 * `pending`. Ramificar sobre ese "todavía no sé" en un daemon recién booteado
 * elegiría el camino de usuario con un installation token — exactamente el 403
 * que esta función existe para evitar. Pedir el token primero fuerza la
 * resolución; el token en sí se descarta.
 */
export async function describeGitHubCredentials(): Promise<CredentialDescription | null> {
  if (!provider) return null
  await provider.getToken()
  return provider.describe()
}
