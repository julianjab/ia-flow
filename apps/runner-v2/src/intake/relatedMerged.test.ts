import { describe, expect, it } from 'bun:test'
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { BoardCard } from '@ia-flow/github-tools'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef } from './parentEvents.js'
import {
  impactPaths,
  notifyRelatedMerged,
  type RelatedMergedPort,
  touched,
} from './relatedMerged.js'

const ctx = {} as PipelineExecutionContext

const prd = (zone: string) =>
  `## Objetivo\nalgo\n<!-- ia-flow:prd.zona_de_impacto -->\n${zone}\n<!-- /ia-flow:prd.zona_de_impacto -->\n**No romper:** \`layers/otra/cosa.ts\``

describe('impactPaths', () => {
  it('saca las rutas entre backticks de la zona de impacto, sin sufijos de línea', () => {
    const body = prd(
      [
        '- [ ] `layers/crm/components/CrmLeadVisitForm/index.vue:230` — extender',
        '- [ ] `services/http/lead/mappers.ts#L187-L191` — mapear',
        '- [ ] `./config/tailwind/spacing.json` y `README.md`',
        '- [ ] El prop `showAgentRow` y `isEditCalendarError` no son rutas',
      ].join('\n'),
    )
    expect(impactPaths(body)).toEqual([
      'layers/crm/components/CrmLeadVisitForm/index.vue',
      'services/http/lead/mappers.ts',
      'config/tailwind/spacing.json',
      'README.md',
    ])
  })

  it('lo que está fuera de la zona no cuenta, y sin zona no hay rutas', () => {
    expect(impactPaths(prd('- [ ] `a/b.ts`'))).toEqual(['a/b.ts'])
    expect(impactPaths('sin PRD: `a/b.ts`')).toEqual([])
  })
})

describe('touched', () => {
  it('cruza por ruta exacta o por carpeta', () => {
    const files = ['a/b.ts', 'a/bc.ts', 'dir/x/y.vue', 'otro.ts']
    expect(touched(['a/b.ts', 'dir/x'], files)).toEqual(['a/b.ts', 'dir/x/y.vue'])
    expect(touched(['dir/'], files)).toEqual(['dir/x/y.vue'])
    expect(touched([], files)).toEqual([])
  })
})

describe('notifyRelatedMerged', () => {
  const merged = { owner: 'la-haus', repo: 'front', pr: 4502 }
  const card = (n: number, status: string, extra: Partial<BoardCard> = {}): BoardCard => ({
    ref: `la-haus/front#${n}`,
    projectId: 'p',
    title: `t${n}`,
    url: '',
    status,
    labels: [],
    updatedAt: '',
    blockedBy: [],
    ...extra,
  })

  function port(cards: BoardCard[], bodies: Record<number, string>, closing: IssueRef[] = []) {
    const published: Array<{ task: number; fields: EventFields }> = []
    const p: RelatedMergedPort = {
      cards: async () => cards,
      pullFiles: async () => ['layers/crm/a.vue', 'layers/crm/b.ts'],
      closingIssues: async () => closing,
      issueBody: async (task) => bodies[task.number] ?? '',
      publish: async (_ctx, task, fields) => {
        published.push({ task: task.number, fields })
        return {
          scope: { issue: `la-haus/front#${task.number}` },
        } as unknown as DomainEvent<unknown>
      },
    }
    return { p, published }
  }

  const STATUSES = ['Refine', 'Refined', 'Build']

  it('avisa a las tasks sin PR cuyo PRD nombra un archivo del PR, con los archivos en común', async () => {
    const { p, published } = port([card(4507, 'Refined'), card(4508, 'Refined')], {
      4507: prd('- `layers/crm/a.vue`'),
      4508: prd('- `layers/otra/z.vue`'),
    })
    const result = await notifyRelatedMerged(p, ctx, merged, STATUSES)
    expect(result).toEqual({ emitted: ['la-haus/front#4507'] })
    expect(published).toEqual([
      {
        task: 4507,
        fields: {
          emit: 'issue.related_merged',
          extra: { mergedPr: 'la-haus/front#4502', files: ['layers/crm/a.vue'] },
        },
      },
    ])
  })

  it('no mira tasks con PR propio, de otra columna, de otro repo, ni las que cierra el PR', async () => {
    const body = prd('- `layers/crm/`')
    const { p, published } = port(
      [
        card(1, 'Build', { pr: { number: 9, url: '' } }),
        card(2, 'Review'),
        { ...card(3, 'Refined'), ref: 'la-haus/api#3' },
        card(4, 'Refined'),
      ],
      { 1: body, 2: body, 3: body, 4: body },
      [{ owner: 'la-haus', repo: 'front', number: 4 }],
    )
    const result = await notifyRelatedMerged(p, ctx, merged, STATUSES)
    expect(result).toEqual({ skipped: 'ninguna task de la-haus/front#4502 espera sin PR' })
    expect(published).toEqual([])
  })

  it('sin intersección, lo dice', async () => {
    const { p } = port([card(4507, 'Refine')], { 4507: prd('- `x/y.ts`') })
    expect(await notifyRelatedMerged(p, ctx, merged, STATUSES)).toEqual({
      skipped: 'la-haus/front#4502 no toca la zona de impacto de ningún PRD',
    })
  })
})
