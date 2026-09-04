---
description: Corre el pipeline sobre un issue de GitHub y lo mueve al estado siguiente
argument-hint: <número de issue>
allowed-tools: Bash, Read, Grep, Glob, Edit, Write
---

Trabajá el issue **#$1** con el pipeline de `ia-flow-cli`.

## 1. Pedí el trabajo

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/flow.mjs run $1 --exec print
```

Ese comando lee el issue, deriva su estado de la label `status:*`, elige qué
agente le toca y te imprime **el prompt de ese agente ya renderizado**. También
marca el issue como en curso, para que nada más lo tome en paralelo.

Si en vez del prompt te contesta que el issue no tiene la label ancla, que ya
hay un run en vuelo, o que ningún agente matchea: **pará ahí y contale al
usuario lo que dijo**. No inventes el trabajo por tu cuenta ni muevas labels a
mano — que ningún agente aplique es información, no un obstáculo.

## 2. Hacé el trabajo

Seguí el prompt que te imprimió, tal como está. Ese prompt es la definición del
agente que el usuario escribió en su `runner.yaml`: no lo reinterpretes ni le
agregues alcance.

## 3. Cerrá el run

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/flow.mjs apply $1 --exit <salida> --summary "<una línea>"
```

Eso publica tu reporte como comentario y mueve la label al estado siguiente.

- `--exit success` es la salida normal, y `--exit error` la de un run que no
  pudo completarse.
- Si el prompt listaba otras salidas con su "cuándo", y tu hallazgo encaja en
  una, usá esa: para eso están declaradas.
- El `--summary` es lo que queda escrito en el issue. Escribilo para la próxima
  persona (o el próximo agente) que lo lea, no como un log de lo que hiciste.

**El comentario y la label los escribe `apply`, siempre.** No comentes con `gh`
ni edites labels vos: un comentario que no pasa por acá no lleva el marker que
el pipeline necesita para distinguirlo del feedback humano.

Si abandonás el trabajo a mitad de camino, decíselo al usuario: el issue queda
marcado como en curso hasta que alguien corra `apply`, o `run ... --force`.
