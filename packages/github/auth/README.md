# @ia-flow/github-auth

Auth de GitHub — login de USUARIO (un PAT o un OAuth user token ya emitido) o de GITHUB APP
(PEM → JWT RS256 → installation token, cacheado), intercambiables detrás de una sola interfaz.
Standalone: cero dependencias runtime, sólo `node:crypto` y `fetch` globales.

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/github-auth test
```

## Uso

```ts
import { GithubAppAuth, GithubTokenAuth } from '@ia-flow/github-auth';

// Login de usuario — un PAT o un token OAuth ya conseguido por vos.
const userAuth = new GithubTokenAuth(process.env.GITHUB_TOKEN!);

// Login de GitHub App — PEM (contenido, no path: leerlo de disco es tuyo) + appId + installationId.
const appAuth = new GithubAppAuth({
  appId: '4752324',
  installationId: '157297744',
  privateKey: await readFile('/secrets/github-app/private-key.pem', 'utf8'),
});

// Cualquier caller que reciba un GithubAuth no sabe (ni le importa) cuál de las dos le diste.
const token = await appAuth.getToken();
```

`GithubAppAuth` cachea el installation token (vive ~1h) y lo refresca solo, con margen
configurable (`refreshMarginMs`, default 5 min).

## Quién lo consume

[`@ia-flow/github-api`](../api) — su `GithubClient` toma cualquier `GithubAuth` para resolver
el token de cada request. Este paquete no sabe qué es un `GithubClient`.
