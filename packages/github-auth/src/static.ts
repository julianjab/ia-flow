import type { CredentialDescription, ICredentialProvider } from '@ia-flow/shared'

/**
 * PAT (o cualquier token opaco) fijo. Es lo que ia-flow hizo siempre, ahora
 * detrás del contrato en vez de un `Bun.env.GITHUB_TOKEN` esparcido por seis
 * archivos.
 *
 * También es el provider de los tests: `new StaticCredentials('fake')` en vez
 * de ensuciar el env del proceso de test.
 */
export class StaticCredentials implements ICredentialProvider {
  readonly #token: string | undefined

  constructor(token: string | undefined) {
    // '' es tan "sin token" como undefined, y llega así desde un .env con la
    // variable declarada y vacía.
    this.#token = token?.trim() || undefined
  }

  async getToken(): Promise<string | undefined> {
    return this.#token
  }

  describe(): CredentialDescription {
    return { mode: 'static', identity: this.#token ? 'static-token' : undefined }
  }

  /** Sin token no hay nada que ofrecer: `auto` salta a la siguiente estrategia. */
  get configured(): boolean {
    return this.#token !== undefined
  }
}
