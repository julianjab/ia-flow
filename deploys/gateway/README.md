# El gateway de providers, en contenedor

Instancia de la imagen [`containers/gateway`](../../containers/gateway/README.md).

**Antes de usar esto, preguntate si lo necesitás.** Los otros tres deploys de
esta carpeta asumen que el gateway corre en tu host
(`cd apps/ai-provider-gateway && bun run dev`), y para el uso normal eso es más
simple: mismo proceso, logs en la terminal, sin rebuild al cambiar código.

Esta carpeta existe para cuando el gateway **no puede** vivir en tu Mac:

- una máquina con más RAM que la tuya,
- una VM cerca de los repos (menos latencia de clone),
- un host que no se suspende — que es la diferencia más concreta, porque un
  gateway dormido se cae del `ProviderRegistry` del server y sus agentes pasan
  a diferirse (ver "Salud" en el CLAUDE.md de la raíz).

## Levantarlo

```bash
cp gateway.env.example .env    # completar valores reales
podman compose up -d --build   # o: docker compose up -d --build
podman compose logs -f
```

## Lo mínimo que hay que configurar

| Variable | Por qué |
| --- | --- |
| `API_AI_PROVIDER_TOKEN` | **Obligatoria.** Es la única auth que tiene. Sin ella, cada request se rechaza con 500 — no arranca "abierto", arranca inútil. El server que lo use tiene que mandar el mismo valor. |
| `ANTHROPIC_API_KEY` **o** `CLAUDE_CODE_OAUTH_TOKEN` | La credencial con la que corre el modelo. Con una alcanza. |
| `IA_FLOW_GATEWAY_PUBLIC_URL` | Cómo lo alcanza el SERVER, no cómo lo ves vos. Ver abajo. |

## La URL pública es la trampa de este deploy

`IA_FLOW_GATEWAY_PUBLIC_URL` es la dirección **vista desde el server**, y es
donde es fácil equivocarse: `host.containers.internal` sólo resuelve *adentro*
de un contenedor. Si lo ponés ahí, el gateway se auto-registra con una URL que
el server no puede alcanzar, y **todo dispatch remoto falla** — con el agravante
de que el registro parece exitoso.

- server en tu host + este contenedor → `http://localhost:3002`
  (el compose publica en `127.0.0.1:3002`)
- server en otra máquina → la URL del túnel

En la dirección contraria, `IA_FLOW_REGISTER_SERVER_URLS` sí va con
`host.containers.internal`: ahí quien resuelve es este contenedor.

## Qué persiste

El volumen `/state` guarda su `gateway.json` (contra qué servers se registra,
su cap de concurrencia) y, con el provisioner activo, los clones de los repos
en `/state/repos`. **Lo que elijas desde la pantalla del gateway gana sobre las
env vars** y sobrevive al restart — las variables son sólo el arranque en frío
(ver `apps/ai-provider-gateway/src/state.ts`).

## Correr agentes de terminal

`claude-print`, `tmux-claude` e `iterm-claude` necesitan el CLI `claude` en el
PATH, y la imagen no lo trae. Instalalo en la imagen o montalo desde el host si
vas a registrar esos providers. `anthropic-api` —el que corre por default y el
fallback garantizado de todo agente con `remote:*`— no lo necesita.
