# @ia-flow/github-auth

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## Estructura

```
src/
├── GithubAuth.ts        interfaz { getToken(): Promise<string> }
├── GithubTokenAuth.ts    login de usuario — wrapper trivial de un token ya emitido
├── GithubAppAuth.ts      login de GitHub App — JWT RS256 (node:crypto, sin deps) + cache
├── index.ts
└── tests/
```

## JWT de GitHub App sin dependencias

`GithubAppAuth` arma el JWT (header + claims + firma RS256) a mano con `node:crypto`
(`createSign('RSA-SHA256')` + `Buffer.toString('base64url')`) — no hace falta un paquete tipo
`jsonwebtoken`. `APP_JWT_TTL_SECONDS = 9 * 60` (el tope de GitHub es 10 min, dejamos margen) y
`CLOCK_SKEW_SECONDS = 60` hacia atrás en `iat` (un reloj local adelantado hace que GitHub
rechace el JWT con "not yet valid").

## Tests

`src/tests/`, `vitest.config.ts` mira `src/**/tests/**/*.test.ts`. Nada pega a la red real —
`fetchImpl` es siempre inyectable. `GithubAppAuth.test.ts` genera un keypair RSA real con
`node:crypto` (`generateKeyPairSync`) y verifica la firma del JWT contra la clave pública — no
basta con decodificar el JWT, hay que probar que la firma es válida de verdad.

## Antes de tocar código

```bash
bun run --filter @ia-flow/github-auth typecheck
bun run --filter @ia-flow/github-auth test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
