/**
 * Contrato único para "cómo hablarle a GitHub con una identidad" — lo que varía es CÓMO se
 * consigue el token, nunca cómo se usa. `GithubTokenAuth` (login de usuario: un PAT o un OAuth
 * user token ya emitido) y `GithubAppAuth` (login de GitHub App: PEM → installation token) son
 * intercambiables detrás de esto — cualquier caller que necesite un token (un `GithubClient`
 * propio, el `authorizationToken` de un `McpServerRef` de `@ia-flow/agent-engine`, un
 * `fetch` a mano) recibe un `GithubAuth`, nunca sabe cuál de las dos implementaciones tiene
 * enfrente.
 */
export interface GithubAuth {
  /** Puede ser sync (un PAT ya está resuelto) o async (un installation token vence y hay que
   *  refrescarlo) — por eso siempre devuelve una Promise, incluso `GithubTokenAuth`. */
  getToken(): Promise<string>
}
