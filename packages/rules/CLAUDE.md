# @ia-flow/rules

Las dos piezas puras con las que el engine y la web leen una config YAML: una **condición**
(`Condition`, el `when` de una pipeline, de una acción de la bandeja o de un dashboard) y una
**plantilla** (`render`: los `{{path}}`).

## Qué es y qué NO es

Sin dependencias, sin I/O, sin saber de agentes, pipelines, eventos ni Vue: una condición se evalúa
contra un objeto cualquiera y una plantilla se resuelve contra otro. Por eso puede importarlo
la web (que no puede traer el engine) y el engine a la vez, y el `when` significa **lo mismo** en
los dos lados.

Si necesitás el contexto de una pipeline (`PipelineExecutionContext`) para armar el objeto, eso es
del engine (`templateRoot`): acá no entra.

## Estructura

```
src/
├── Condition.ts   ops, `and`/`or` en cadena de izquierda a derecha, `matches` con regex compilada
├── template.ts    render / renderText / hasTemplate / substituteVars
└── tests/         vitest
```

```bash
bun run --cwd packages/rules test
bun run --cwd packages/rules typecheck
```
