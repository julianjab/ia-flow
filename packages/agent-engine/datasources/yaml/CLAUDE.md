# @ia-flow/agent-engine-datasource-yaml

Un datasource de `@ia-flow/agent-engine`: traduce YAML a definiciones (`SourceDocs` de
`@ia-flow/agent-engine-definitions`). Nada más: no arma entidades, no compone el
engine, no sabe de proyectos. Cambiarlo por otro datasource (SQLite, Postgres) es cambiar quién
produce las definiciones.

Una fuente se declara de dos formas:

- **`spec`**: entradas explícitas, típicamente las de un índice de la app (su `runner.yaml`).
  `source` es un archivo o inline; `agents` y `pipelines` aceptan, solas o en lista:
  un directorio (sus `*.yaml`, en orden de nombre), un archivo, un glob en el nombre del archivo
  (`./pipelines/1*.yaml`; `*` y `?`) o el documento inline. Las rutas son relativas a `base`; un
  inline se ubica en los errores como `<origin>: pipelines[i]`. Si `spec` es una función, se vuelve
  a pedir cuando cambia un archivo de `watch` (el índice): editar la lista recarga la fuente.
- **`dir`**: el layout de carpeta, un atajo de `spec`:

```
<dir>/
  source.yaml         id, vars, systemPrompts, onError, onInterrupt, report   (opcional)
  agents/*.yaml       un agente por archivo
  pipelines/*.yaml    una pipeline por archivo, en orden de nombre
```

- **`YamlDefinitionSource`** — `read()` lee y valida cada documento contra el schema de las
  definiciones (errores con dónde y qué campo); `version()` es la firma del índice (`watch`) y de
  los archivos que declara (fecha, tamaño, uno nuevo o borrado). Una referencia que no existe
  rompe la lectura. Su id: la opción `id`, si no el de su `source`, y si no el nombre de `base`.
  `fromRoot(root)`: una fuente por subcarpeta.
- **`vars`** (las de `source.yaml` sobre la opción `vars`): `{{vars.x}}` se sustituye en el YAML
  crudo ANTES de validar, así el schema ve el valor real; una var que no existe rompe la lectura.
- Para servirla al engine: `new DefinitionPipelineSource(new YamlDefinitionSource({ dir }), catalogs)`.

## Antes de commitear

```bash
bun run --filter @ia-flow/agent-engine-datasource-yaml typecheck
bun run --filter @ia-flow/agent-engine-datasource-yaml test
```
