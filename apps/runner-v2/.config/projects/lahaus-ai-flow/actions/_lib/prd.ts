/**
 * Los PRD de claw-agents como datos: el schema es lo que el modelo tiene que mandar, y `render`
 * produce EXACTAMENTE la plantilla que hoy los prompts describen en prosa (10-refiner.yaml,
 * 12-frontend-refiner.yaml y 05-functional-refiner.yaml). Reglas que hoy son texto del prompt
 * —"seis secciones y ninguna más", "cada ítem de Zona de impacto con su archivo", "al menos un
 * criterio"— pasan a ser estructura que se valida antes de tocar el issue.
 *
 * Los checklists que otro agente tilda van en su propio sub-bloque (`prd.zona_de_impacto`,
 * `prd.criterios_aceptacion`): es lo que `check_*` puede tocar, y nada más.
 */
import { type IssueSectionDefinition, wrapSection } from '@ia-flow/github-tools'
import { z } from 'zod'

const MERMAID_CLASSES = `  classDef creado fill:#c6f6d5,stroke:#2f855a,stroke-width:2px,color:#1a202c
  classDef actualizado fill:#fefcbf,stroke:#b7791f,stroke-width:2px,color:#1a202c
  classDef eliminado fill:#fed7d7,stroke:#c53030,stroke-width:2px,color:#1a202c
  classDef intacto fill:#e2e8f0,stroke:#a0aec0,color:#1a202c`

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim()
const cell = (text: string) => oneLine(text).replace(/\|/g, '\\|')
const bullets = (items: string[]) => items.map((item) => `- ${oneLine(item)}`).join('\n')
const checklist = (id: string, items: string[]) =>
  wrapSection(id, items.map((item) => `- [ ] ${oneLine(item)}`).join('\n'))
const risks = (items: string[]) => (items.length > 0 ? bullets(items) : 'Ninguno')

// --- PRD técnico (refiner, frontend-refiner) ---------------------------------------------------

const TechnicalPrd = z.strictObject({
  objetivo: z
    .string()
    .min(1)
    .describe(
      '2-3 líneas en lenguaje de producto: qué problema resuelve y para quién. Alguien que nunca vio el código tiene que entender por qué vale la pena.',
    ),
  cambios: z
    .array(
      z.strictObject({
        aspecto: z.string().min(1),
        hoy: z
          .string()
          .min(1)
          .describe(
            'Comportamiento actual, en términos observables, escrito DESPUÉS de leer el código',
          ),
        con_el_cambio: z.string().min(1),
      }),
    )
    .min(1)
    .describe('Tabla "Cómo está / cómo queda": una fila por aspecto que cambia, y nada más'),
  diagrama: z
    .union([
      z.strictObject({
        mermaid: z
          .string()
          .min(1)
          .describe(
            'Cuerpo del flowchart (desde `flowchart LR`), con `class <nodos> creado|actualizado|eliminado|intacto`. Los classDef se agregan solos.',
          ),
        que_mirar: z.string().min(1).describe('Una línea diciendo qué mirar en el diagrama'),
      }),
      z.strictObject({
        sin_diagrama: z
          .string()
          .min(1)
          .describe('Razón en media línea — para un cambio acotado (un campo, un copy, un fix)'),
      }),
    ])
    .describe('Sólo si la tarea es de complejidad media o alta; si no, `sin_diagrama`'),
  zona_de_impacto: z
    .array(
      z.strictObject({
        path: z
          .string()
          .regex(/^[\w@./[\]-]+(:\d+(-\d+)?)?$/, 'path/al/archivo.ext o path/al/archivo.ext:línea')
          .describe('path/al/archivo.ext:línea — tiene que existir, o el cambio dice que se crea'),
        cambio: z.string().min(1).describe('Qué cambia ahí, en una línea'),
      }),
    )
    .min(1)
    .describe(
      'EL plan: un ítem por unidad de trabajo del implementador, en orden. El implementador los tilda.',
    ),
  no_romper: z
    .string()
    .min(1)
    .describe('El schema, endpoint o tipo que ya existe y otros consumen. Si no hay, "nada".'),
  criterios_aceptacion: z
    .array(z.string().min(1))
    .min(1)
    .describe('Verificables SIN leer código, por alguien usando el producto'),
  riesgos: z
    .array(z.string().min(1))
    .describe('Sólo lo bloqueante de verdad. Vacío si no hay ninguno.'),
})
type TechnicalPrd = z.infer<typeof TechnicalPrd>

function renderTechnicalPrd(prd: TechnicalPrd): string {
  const diagram =
    'sin_diagrama' in prd.diagrama
      ? `Sin diagrama: ${oneLine(prd.diagrama.sin_diagrama)}`
      : [
          '```mermaid',
          prd.diagrama.mermaid.trimEnd(),
          ...(prd.diagrama.mermaid.includes('classDef creado') ? [] : [MERMAID_CLASSES]),
          '```',
          '',
          '**Leyenda:** 🟩 creado · 🟨 actualizado · 🟥 eliminado · ⬜ sin cambios',
          '',
          oneLine(prd.diagrama.que_mirar),
        ].join('\n')

  return [
    '## 🎯 Objetivo',
    prd.objetivo.trim(),
    '',
    '## 🔄 Cómo está / cómo queda',
    '',
    '| | Hoy | Con este cambio |',
    '|---|---|---|',
    ...prd.cambios.map((c) => `| ${cell(c.aspecto)} | ${cell(c.hoy)} | ${cell(c.con_el_cambio)} |`),
    '',
    '## 🗺️ Diagrama',
    '',
    diagram,
    '',
    '## 🛠️ Zona de impacto',
    '',
    checklist(
      'prd.zona_de_impacto',
      prd.zona_de_impacto.map((item) => `\`${item.path}\` — ${item.cambio}`),
    ),
    '',
    `**No romper:** ${oneLine(prd.no_romper)}`,
    '',
    '## ✅ Criterios de aceptación',
    checklist('prd.criterios_aceptacion', prd.criterios_aceptacion),
    '',
    '## ⚠️ Riesgos y preguntas',
    risks(prd.riesgos),
  ].join('\n')
}

// --- PRD funcional (functional-refiner) ---------------------------------------------------------

const FunctionalPrd = z.strictObject({
  objetivo: z
    .string()
    .min(1)
    .describe('2-3 líneas en lenguaje de producto: qué problema resuelve y para quién'),
  como_funciona_hoy: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe(
      '3-5 bullets del comportamiento actual y dónde duele. Observable, no arquitectónico.',
    ),
  que_cambia: z
    .array(z.string().min(1))
    .min(1)
    .describe('Lo que el usuario/negocio va a poder hacer. Sin jerga.'),
  desglose: z.strictObject({
    mermaid: z
      .string()
      .min(1)
      .describe(
        'Cuerpo del flowchart (desde `flowchart LR`): un nodo por sub-issue, agrupados por repo con subgraph, con flechas de dependencia',
      ),
    sub_issues: z
      .array(
        z.strictObject({
          numero: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('El #N real, una vez creado el sub-issue'),
          titulo: z.string().min(1),
          repo: z.string().min(1),
          depende_de: z
            .array(z.string().min(1))
            .describe('Filas de las que depende: "#12", o el número de fila si todavía no existe'),
          por_que: z.string().min(1).describe('Por qué ese corte y ese orden, en una línea'),
        }),
      )
      .min(1),
  }),
  criterios_aceptacion: z
    .array(z.string().min(1))
    .min(1)
    .describe('Verificables por una persona usando el producto, con TODOS los hijos mergeados'),
  riesgos: z.array(z.string().min(1)).describe('Sólo lo bloqueante de verdad. Vacío si no hay.'),
})
type FunctionalPrd = z.infer<typeof FunctionalPrd>

function renderFunctionalPrd(prd: FunctionalPrd): string {
  const rows = prd.desglose.sub_issues
  return [
    '## 🎯 Objetivo',
    prd.objetivo.trim(),
    '',
    '## 📍 Cómo funciona hoy',
    bullets(prd.como_funciona_hoy),
    '',
    '## ✨ Qué cambia',
    bullets(prd.que_cambia),
    '',
    '## 🗺️ Desglose',
    '',
    '```mermaid',
    prd.desglose.mermaid.trimEnd(),
    '```',
    '',
    '| # | Sub-issue | Repo | Depende de |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row, i) =>
        `| ${row.numero ? `#${row.numero}` : i + 1} | ${cell(row.titulo)} | ${cell(row.repo)} | ${
          row.depende_de.length > 0 ? row.depende_de.map(cell).join(', ') : '—'
        } |`,
    ),
    '',
    ...rows.map((row, i) => `${row.numero ? `#${row.numero}` : i + 1}. ${oneLine(row.por_que)}`),
    '',
    '## ✅ Criterios de aceptación de la épica',
    checklist('prd-funcional.criterios_aceptacion', prd.criterios_aceptacion),
    '',
    '## ⚠️ Riesgos y preguntas abiertas',
    risks(prd.riesgos),
  ].join('\n')
}

// --- El catálogo de bloques ---------------------------------------------------------------------

export interface IssueBodySection {
  definition: IssueSectionDefinition
  /** Los checklists tildables del bloque: `<campo>` → cómo se nombra en la tool. */
  checklists: Record<string, string>
}

/** Los bloques del body que existen. Un permiso (`write`/`check`) sobre otro id es un error de
 *  config y falla al montar, no a mitad de una corrida. */
export const ISSUE_BODY_SECTIONS: Record<string, IssueBodySection> = {
  prd: {
    definition: {
      id: 'prd',
      title: 'PRD técnico',
      schema: TechnicalPrd,
      render: (data) => renderTechnicalPrd(data as TechnicalPrd),
    },
    checklists: {
      zona_de_impacto: 'la Zona de impacto del PRD',
      criterios_aceptacion: 'los Criterios de aceptación del PRD',
    },
  },
  'prd-funcional': {
    definition: {
      id: 'prd-funcional',
      title: 'PRD funcional',
      schema: FunctionalPrd,
      render: (data) => renderFunctionalPrd(data as FunctionalPrd),
    },
    checklists: { criterios_aceptacion: 'los Criterios de aceptación de la épica' },
  },
}
