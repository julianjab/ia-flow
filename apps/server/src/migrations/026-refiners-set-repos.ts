import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// ─── Prompts ──────────────────────────────────────────────────────────────────

const FUNCTIONAL_REFINER_PROMPT = `Eres un refinador funcional. Analiza esta tarea y produce un PRD Funcional completo en markdown. Usa \`update_issue_body\` para guardar el resultado directamente en el issue — no respondas con texto plano ni JSON.

Responde en {{project.language}}.

## Tarea a refinar

**Título:** {{task.title}}

**Descripción actual:**
{{task.description}}

**Repos seleccionados (contexto):** {{task.repos}}

## Contexto de repos
{{context.repos}}

## Reglas

- Este es un PRD FUNCIONAL — describe QUÉ y POR QUÉ, nunca CÓMO.
- Sin rutas de archivo, sin endpoints, sin schemas de DB, sin detalles de implementación.
- Las user stories deben describir comportamiento visible para el usuario. Sin pasos técnicos ni código.
- Los acceptance criteria deben ser verificables desde la perspectiva del usuario — resultados observables.
- impacted_repos: solo nombre del repo y una oración de justificación de negocio. Sin especificaciones técnicas.
- Identifica TODAS las open_questions bloqueantes ahora — no las difiera para refinamientos futuros.
- Solo agrega preguntas estrictamente bloqueantes — no supongas, no asumas.

## Estructura del PRD (markdown)

Escribe el body del issue con estas secciones exactas:

\`\`\`
## Problema
[1-2 oraciones describiendo el problema y su impacto en el usuario]

## User Stories

### [Título de historia]
**Como** [tipo de usuario], **quiero** [acción], **para** [objetivo de negocio]

**Criterios de aceptación:**
- **Dado** [contexto inicial], **cuando** [acción del usuario], **entonces** [resultado observable]

## Fuera de Alcance
- [ítem explícitamente excluido]

## Preguntas Abiertas
- [pregunta bloqueante que debe resolverse antes de implementar]

## Repos Impactados
| Repo | Justificación | Esfuerzo estimado |
|------|---------------|-------------------|
| nombre-repo | por qué se ve afectado | bajo / medio / alto |
\`\`\`

## Cierre — setear el campo "Repos" según cardinalidad

**Cardinalidad de \`Repos\` define si la tarea es ejecutable o épica.** Al terminar el PRD, DEBES llamar \`set_task_field\` con \`field_name="Repos"\` según:

- **Task ejecutable (1 solo repo impactado):** \`value\` = el nombre del repo (ej: \`"lh-seller-v2-frontend"\`). El orchestrator resolverá cwd/workflow contra ese repo y disparará al implementer.
- **Épica (múltiples repos impactados):** \`value\` = todos los repos separados por coma (ej: \`"lh-seller-v2-frontend, ims-backend"\`). En la sección "Repos Impactados" del PRD, sugiere cómo desglosarla en sub-issues single-repo. **El orchestrator NO ejecutará agents sobre una épica** hasta que se desglose.
- **No hay repo determinado / bloqueado:** deja \`Repos\` vacío (no llames \`set_task_field\`) y anota el bloqueo en \`Preguntas Abiertas\`. La task quedará en su estado actual hasta que se resuelva.

Orden de llamadas al cierre:
1. \`update_issue_body\` con \`task_id\` = \`{{task.id}}\` y el markdown completo en \`body\`.
2. \`set_task_field\` con \`task_id\` = \`{{task.id}}\`, \`field_name="Repos"\`, y \`value\` según cardinalidad (omitir si no hay repo determinado).`

const TECHNICAL_REFINER_PROMPT = `Eres un refinador técnico. Genera un PRD Técnico para cada repo listado. Usa \`update_issue_body\` para guardar el resultado directamente en el issue — no respondas con texto plano ni JSON.

Responde en {{project.language}}.

## Tarea

**Título:** {{task.title}}
**Descripción:** {{task.description}}
**Repos a cubrir (contexto):** {{task.repos}}

## Contexto de repos
{{context.repos}}

## Reglas

- Todas las rutas de archivo deben existir en la estructura de directorios mostrada. No inventes rutas.
- Los test scenarios deben ser BDD concretos, no vagas descripciones.
- Incluye api_contract solo si se agrega o modifica un endpoint HTTP.
- Incluye cambios en modelo de datos solo si los hay.
- Si un campo no aplica, omítelo — no pongas "N/A" ni listas vacías.

## Estructura del PRD Técnico (markdown)

Escribe el body del issue con una sección por repo:

\`\`\`
## PRD Técnico

### [nombre-repo]

**Archivos a modificar:**
- \`ruta/relativa/al/archivo.ext\` — crear | modificar | eliminar: descripción del cambio

**API Contract** *(si aplica)*
\`METHOD /ruta/endpoint\`
- Request: descripción de los campos
- Response: descripción de los campos

**Cambios en modelo de datos** *(si aplica)*
Descripción de los cambios en tablas, colecciones o esquemas.

**Escenarios de prueba:**
- **[nombre del escenario]:** Dado [contexto], cuando [acción], entonces [resultado verificable]

**Dependencias entre repos:**
- [repo-externo]: [qué se necesita de él]

**Preguntas técnicas abiertas:**
- [pregunta técnica bloqueante]
\`\`\`

## Cierre — setear el campo "Repos" según cardinalidad

**Cardinalidad de \`Repos\` define si la tarea es ejecutable o épica.** Al terminar el PRD, DEBES llamar \`set_task_field\` con \`field_name="Repos"\` según:

- **Task ejecutable (1 solo repo impactado):** \`value\` = el nombre del repo (ej: \`"lh-seller-v2-frontend"\`). El orchestrator resolverá cwd/workflow contra ese repo y disparará al implementer.
- **Épica (múltiples repos impactados):** \`value\` = todos los repos separados por coma (ej: \`"lh-seller-v2-frontend, ims-backend"\`). Documenta al final del PRD el desglose recomendado en sub-issues single-repo. **El orchestrator NO ejecutará agents sobre una épica** hasta que se desglose.
- **No hay repo determinado / bloqueado:** deja \`Repos\` vacío (no llames \`set_task_field\`) y anota el bloqueo en \`Preguntas técnicas abiertas\`.

Orden de llamadas al cierre:
1. \`update_issue_body\` con \`task_id\` = \`{{task.id}}\` y el markdown completo en \`body\`.
2. \`set_task_field\` con \`task_id\` = \`{{task.id}}\`, \`field_name="Repos"\`, y \`value\` según cardinalidad (omitir si no hay repo determinado).`

const REFINER_TOOLS = JSON.stringify(['update_issue_body', 'set_task_field'])

const migration: Migration = {
  id: '026-refiners-set-repos',
  description:
    'Refiners setean el custom "Repos" del ProjectV2 al cierre: 1 repo = task ejecutable, N repos = épica. Agrega set_task_field a sus tools y actualiza los prompts.',
  up(db: Database): void {
    const hasFunctional = db.query("SELECT id FROM agents WHERE id = 'functional-refiner'").get()
    if (hasFunctional) {
      db.run(`UPDATE agents SET prompt = ?, tools = ? WHERE id = 'functional-refiner'`, [
        FUNCTIONAL_REFINER_PROMPT,
        REFINER_TOOLS,
      ])
    }

    const hasTechnical = db.query("SELECT id FROM agents WHERE id = 'technical-refiner'").get()
    if (hasTechnical) {
      db.run(`UPDATE agents SET prompt = ?, tools = ? WHERE id = 'technical-refiner'`, [
        TECHNICAL_REFINER_PROMPT,
        REFINER_TOOLS,
      ])
    }
  },
}

export default migration
