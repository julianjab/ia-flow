import { describe, expect, it } from 'vitest'
import {
  carryChecks,
  listChecklist,
  readSection,
  sectionMarkers,
  setChecked,
  wrapSection,
  writeSection,
} from '../issueSection.js'

const HUMAN = 'Descripción que escribió una persona.\n\n- un link: https://figma.com/design/abc'

describe('writeSection', () => {
  it('appends the block after the human description when it does not exist yet', () => {
    const body = writeSection(HUMAN, 'prd', '## 🎯 Objetivo\nX')

    expect(body).toBe(
      `${HUMAN}\n\n<!-- ia-flow:prd -->\n## 🎯 Objetivo\nX\n<!-- /ia-flow:prd -->\n`,
    )
  })

  it('writes an empty body as just the block', () => {
    expect(writeSection('', 'prd', 'X')).toBe('<!-- ia-flow:prd -->\nX\n<!-- /ia-flow:prd -->\n')
  })

  it('replaces only its own block, leaving the human text and other blocks intact', () => {
    const before = `${HUMAN}\n\n${wrapSection('prd', 'viejo')}\n\n${wrapSection('notas', 'de otro agente')}\n`

    const after = writeSection(before, 'prd', 'nuevo')

    expect(after).toBe(
      `${HUMAN}\n\n${wrapSection('prd', 'nuevo')}\n\n${wrapSection('notas', 'de otro agente')}\n`,
    )
  })

  it('refuses a block that opens but never closes instead of guessing where it ends', () => {
    expect(() => writeSection('<!-- ia-flow:prd -->\nroto', 'prd', 'x')).toThrow(
      /abre pero no cierra/,
    )
  })

  it('rejects ids that could break out of the marker comment', () => {
    expect(() => sectionMarkers('prd --> <script>')).toThrow(/id de bloque inválido/)
  })
})

describe('readSection', () => {
  it('reads a nested block by its own id', () => {
    const body = wrapSection('prd', `## Zona\n${wrapSection('prd.zona', '- [ ] a')}`)

    expect(readSection(body, 'prd.zona')).toBe('- [ ] a')
    expect(readSection(body, 'otro')).toBeUndefined()
  })
})

describe('setChecked', () => {
  const body = `${HUMAN}\n\n${wrapSection(
    'prd',
    [
      '## Zona',
      wrapSection('prd.zona', '- [ ] `a.ts` — uno\n- [x] `b.ts` — dos\n- [ ] `c.ts` — tres'),
      '## Criterios',
      wrapSection('prd.criterios', '- [ ] criterio'),
    ].join('\n'),
  )}`

  it('ticks only the requested items of that list and leaves every other byte alone', () => {
    const { body: after, items } = setChecked(body, 'prd.zona', [1, 3], true)

    expect(after).toBe(
      body.replace('- [ ] `a.ts`', '- [x] `a.ts`').replace('- [ ] `c.ts`', '- [x] `c.ts`'),
    )
    expect(items.map((item) => item.checked)).toEqual([true, true, true])
    expect(readSection(after, 'prd.criterios')).toBe('- [ ] criterio')
  })

  it('unticks', () => {
    expect(setChecked(body, 'prd.zona', [2], false).items[1]).toEqual({
      index: 2,
      checked: false,
      text: '`b.ts` — dos',
    })
  })

  it('fails on an item that does not exist, without partial changes', () => {
    expect(() => setChecked(body, 'prd.zona', [1, 4], true)).toThrow(
      /tiene 3 ítems — no existen: 4/,
    )
  })

  it('fails when the list is not in the body', () => {
    expect(() => setChecked(HUMAN, 'prd.zona', [1], true)).toThrow(/no tiene el bloque "prd.zona"/)
  })
})

describe('listChecklist', () => {
  it('numbers checkbox lines from 1 and ignores plain bullets', () => {
    expect(listChecklist('- nota\n- [ ] a\n* [X] b')).toEqual([
      { index: 1, checked: false, text: 'a' },
      { index: 2, checked: true, text: 'b' },
    ])
  })
})

describe('carryChecks', () => {
  it('keeps the ticks of items whose text did not change, and leaves new or reworded ones open', () => {
    const previous = '- [x] `a.ts` — uno\n- [x] `b.ts` — dos\n- [ ] `c.ts` — tres'
    const next =
      '- [ ] `a.ts` — uno\n- [ ] `b.ts` — dos, reescrito\n- [ ] `c.ts` — tres\n- [ ] `d.ts` — nuevo'

    expect(carryChecks(previous, next)).toBe(
      '- [x] `a.ts` — uno\n- [ ] `b.ts` — dos, reescrito\n- [ ] `c.ts` — tres\n- [ ] `d.ts` — nuevo',
    )
  })
})
