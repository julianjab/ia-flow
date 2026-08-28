# @ia-flow/figma-auth

La credencial del **MCP remoto de Figma** (`https://mcp.figma.com/mcp`), detrás
del mismo contrato que la de GitHub: `ICredentialProvider`
(`packages/shared/src/credentials.ts`).

```
scripts/figma-login.ts ──► runFigmaLogin() ──► ~/.config/ia-flow/figma-oauth.json
                                                        │
composition/container.ts ──► setSecretResolver ──► FigmaCredentials.getToken()
                                                        │
                                    agente con `authorizationToken: '${FIGMA_TOKEN}'`
```

## Por qué OAuth y no un PAT

El MCP de Figma no acepta el `X-Figma-Token` de la REST API: responde `401` con
`WWW-Authenticate: Bearer ... scope="mcp:connect"`. Es un recurso protegido de
OAuth 2.1 con su propio authorization server (`https://api.figma.com`), y el
único camino a un token es un authorization code con PKCE.

De ahí sale casi todo lo demás:

- **PKCE S256 obligatorio, sin caer a `plain`.** El `code_verifier` nunca sale
  del proceso; lo único que viaja por el browser es su SHA-256. Si el AS
  dejara de publicar `S256`, `discoverAuthServer` **falla** en vez de degradar:
  sin PKCE, un code interceptado es un token.
- **Descubrimiento en dos saltos** (recurso → authorization server) en vez de
  hardcodear `api.figma.com`. El 401 del propio MCP trae el puntero al
  metadata, así que seguirlo es gratis y sobrevive a que Figma mueva su AS.
- **`resource=https://mcp.figma.com/mcp` (RFC 8707)** en authorize y en token:
  ata el access token a ESTE recurso y no a cualquier otra API que comparta el
  mismo AS.
- **Registro dinámico (RFC 7591) con fallback escrito.** Evita tener que crear
  una app OAuth a mano; si Figma lo rechaza, el error dice cuál es la salida
  (`--client-id` / `FIGMA_OAUTH_CLIENT_ID`) en vez de dejar un 403 pelado. Un
  login posterior **reusa** el cliente ya guardado: cada registro deja un
  cliente OAuth más del lado de Figma.

## La regla que hace que esto funcione

**El token se resuelve por uso, nunca se captura** — la misma que rige el
installation token de la GitHub App, y por el mismo motivo: un access token de
OAuth vive minutos y el daemon vive días. Quien guarde el string en un
constructor va a mandar un token vencido y comerse un 401 del MCP lejos de la
causa.

Por eso el consumidor es `setSecretResolver` (`agent-engine`), que llama a
`getToken()` en **cada** expansión de `${FIGMA_TOKEN}`, y por eso
`FigmaCredentials` lee `FIGMA_MCP_TOKEN` del env dentro de `getToken()` y no en
el constructor: en `apps/server` las variables guardadas en SQLite entran al
proceso recién en `envRepo.loadIntoProcess()`, después de que el container se
evaluó.

## Decisiones que no son obvias

| Decisión | Por qué |
| --- | --- |
| La sesión es un **archivo** (`figma-oauth.json`, 0600), no una fila de la tabla de env vars | La escribe un script de CLI en otro proceso que el daemon —abrir su SQLite para eso es pedir un lock que no necesitamos— y un refresh token no es config que alguien edite en un textarea. |
| Sin sesión, `getToken()` devuelve `undefined` (no tira) | Nadie corrió el login todavía = integración no configurada, que es el estado normal de quien no usa Figma. Un throw ahí rompería runs que no tienen nada que ver. |
| Con sesión vencida y sin refresh token, **tira** | Acá sí hay algo configurado y roto. El silencio dejaría al agente hablando con el MCP sin `Authorization`, y el 401 aparecería lejos de la causa. |
| Un refresh fallido **no se cachea** (se limpian metadata y sesión) | El remedio es correr el login de nuevo; si el fallo quedara pegado, hacerlo no arreglaría nada hasta reiniciar el daemon. Mismo razonamiento que el `pending = null` de `lazyGitHubCredentials`. |
| El refresh conserva el refresh token viejo si la respuesta no trae uno | RFC 6749 §5.1 lo declara opcional. Pisarlo con `undefined` dejaría la sesión sin forma de renovarse otra vez. |
| Sin `expires_in` no se inventa vencimiento | Renovar de más contra un AS que no declaró vida útil es adivinar; el token se usa hasta que el server lo rechace. |
| Renovaciones concurrentes comparten una promesa | N runs que arrancan juntos piden UN token. Mismo dedupe que `GitHubAppCredentials`. |
| `FIGMA_MCP_TOKEN` es sólo un escape hatch | Un token pegado a mano no se renueva. Existe para el deploy headless que no puede abrir un browser; se usa únicamente si no hay sesión. |

## Uso

```bash
bun run auth:figma              # login (abre el browser)
bun run auth:figma -- --status  # qué sesión hay
bun run auth:figma -- --logout  # borrarla
```

Después, en el MCP del agente:

```json
{ "figma": { "type": "http", "url": "https://mcp.figma.com/mcp", "authorizationToken": "${FIGMA_TOKEN}" } }
```

El puerto del redirect (`51789`) queda fijado en el `redirect_uri` del cliente
registrado: cambiarlo obliga a registrar uno nuevo.

## Config nueva → variable en `ENV_VAR_DEFINITIONS`

Misma regla que `github-auth`: toda variable que este paquete lea tiene que
estar declarada en `apps/server/src/routes/env-vars.ts` y ofrecida desde
`composition/config-vars.ts`, o queda editable sólo por `.env` y nadie la
encuentra.
