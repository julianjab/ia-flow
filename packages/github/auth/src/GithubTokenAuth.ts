import type { GithubAuth } from './GithubAuth.js'

/**
 * Login de USUARIO — envuelve un token ya emitido (un PAT clásico/fine-grained, o un OAuth user
 * access token conseguido por fuera de este paquete). No hace ningún request: el token ya es
 * válido cuando se lo pasás, y esta clase sólo lo expone detrás de `GithubAuth` para que sea
 * intercambiable con `GithubAppAuth` sin que el caller sepa la diferencia.
 */
export class GithubTokenAuth implements GithubAuth {
  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    return this.token
  }
}
