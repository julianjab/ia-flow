import type { ICredentialProvider } from '@ia-flow/shared'

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
