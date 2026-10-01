# @ia-flow/github-api

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## Depende de `@ia-flow/github-auth`, nada más

Única dependencia runtime del monorepo — necesita el tipo `GithubAuth` para no acoplarse a una
implementación concreta. No depende de `@ia-flow/github-webhook` ni de `@ia-flow/agent-engine`.

## Validación de host — no es opcional

`request()` resuelve la URL con `new URL(path, GITHUB_API_URL)` y exige que el `origin`
resultante sea exactamente `https://api.github.com` ANTES de adjuntar el header `Authorization`.
Esto existe porque `path` puede venir de datos que no controlás del todo (un `Link` header de
paginación, o —vía `@ia-flow/github-tools`— un valor que en última instancia decidió un
modelo). Sin el chequeo, una URL absoluta a otro host, o un path protocol-relative
(`//evil.example.com/x`, que `new URL` resuelve a otro origin), filtraría el token. Si tocás esta
función, no saques el chequeo aunque parezca redundante en el caso feliz.

## Estructura

```
src/
├── GithubClient.ts   la clase
├── index.ts
└── tests/
```

## Antes de tocar código

```bash
bun run --filter @ia-flow/github-api typecheck
bun run --filter @ia-flow/github-api test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
