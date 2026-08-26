# containers/ — las imágenes OCI de ia-flow

Un subdirectorio por imagen, cada uno con su `Dockerfile` y su
`Dockerfile.dockerignore`. `podman` y `docker` sirven las dos; nada acá asume
uno de los dos runtimes, y por eso la carpeta no se llama `docker/`.

| Imagen | Qué corre | Cuándo la querés |
| --- | --- | --- |
| `runner/` | `apps/server`, flavor `runner` | el engine headless: escanea un board, despacha agentes, no expone API. Su config es un `runner.yaml` bind-monteado |
| `gateway/` | `apps/ai-provider-gateway` | ejecutar agentes en la máquina que tiene las credenciales, el CLI `claude` o el filesystem — registrada contra un server/runner por HTTP |

## Por qué no viven junto a su app

**Todas se construyen con la raíz del repo como contexto**, porque necesitan el
workspace de Bun completo (los `packages/*` son `workspace:*`, no publicados).
Un `Dockerfile` dentro de `apps/x/` que sólo se puede construir desde dos
niveles más arriba miente sobre dónde pertenece:

```bash
# desde la raíz del repo, siempre
podman build -f containers/gateway/Dockerfile -t ia-flow-gateway .
```

Juntarlas además hace visible de un vistazo qué se despliega — que era
imposible cuando cada `Dockerfile` estaba escondido en la carpeta de su app.

## Imágenes vs. deploys

Acá va **cómo se construye** una imagen. **Con qué config se corre** vive en
`deploys/`: cada subcarpeta de ahí es una instancia (su `docker-compose.yml`,
su YAML de agentes, su `.env`) y varias pueden compartir la misma imagen. Una
imagen no conoce ningún proyecto de GitHub; un deploy no construye nada que no
esté acá.
