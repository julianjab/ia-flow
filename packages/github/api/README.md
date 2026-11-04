# @ia-flow/github-api

Cliente delgado y autenticado de la REST API de GitHub. Toma cualquier `GithubAuth` de
[`@ia-flow/github-auth`](../auth) (login de usuario o de GitHub App) — no sabe ni le importa
cuál de las dos le diste.

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/github-api test
```

## Uso

```ts
import { GithubTokenAuth } from '@ia-flow/github-auth';
import { GithubClient } from '@ia-flow/github-api';

const client = new GithubClient({ auth: new GithubTokenAuth(process.env.GITHUB_TOKEN!) });

const issue = await client.requestJson('/repos/o/r/issues/1');
// o, para lo que no tiene un 2xx garantizado:
const res = await client.request('/repos/o/r/issues/1');
```

`request` valida que la URL resuelta (relativa o absoluta) caiga dentro de
`https://api.github.com` antes de adjuntar el token — un path armado con datos externos (un
`Link` header manipulado, un valor que vino de un modelo) no puede hacer que el cliente mande el
`Authorization` a otro host.

## Límites de tasa

El cliente cuida el límite secundario de GitHub (el de ráfagas) por identidad — todos los
`GithubClient` con el mismo `auth` comparten una compuerta:

- a lo sumo `maxConcurrent` (6) requests en vuelo, y las escrituras (REST que no es GET/HEAD,
  `mutation` de GraphQL) de a una, con `writeGapMs` (1 s) de aire entre ellas;
- un 403/429 de límite de tasa (body "rate limit", `retry-after`, `x-ratelimit-remaining: 0`) se
  reintenta hasta `retry.maxRetries` (3) veces, esperando lo que pide GitHub o 60 s × 2ⁿ con
  jitter — y mientras tanto no sale ningún otro request de esa identidad;
- un 502/503/504 se reintenta sólo en lecturas (una escritura pudo haberse aplicado);
- lo que igual falla sale como `GithubApiError`, con `transient: true` si rehacerlo es seguro (un
  límite de tasa, o un 5xx o fallo de red de una lectura; una escritura sin respuesta pudo haberse
  aplicado): el engine no lo trata como un fallo de la task, reintenta el evento.

## Quién lo consume

[`@ia-flow/github-tools`](../tools) — envuelve un `GithubClient` en `Tool[]` para
`@ia-flow/agent-engine`. Este paquete no sabe qué es un `Tool` ni un `Agent`.
