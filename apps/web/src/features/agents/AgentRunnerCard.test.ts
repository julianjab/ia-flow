import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentRunnerCard, {
  type AgentRunnerEntry,
  type LabelOps,
  deserializeLabels,
  emptyEntry,
  emptyLabelOps,
  serializeLabels,
} from './AgentRunnerCard.vue'

// ─── serializeLabels / deserializeLabels ─────────────────────────────────────

describe('serializeLabels', () => {
  it('returns empty string for empty ops', () => {
    expect(serializeLabels(emptyLabelOps())).toBe('')
  })

  it('emits + prefix for add labels', () => {
    expect(serializeLabels({ add: ['a', 'b'], remove: [], replace: [] })).toBe('$labels:+a,+b')
  })

  it('emits - prefix for remove labels', () => {
    expect(serializeLabels({ add: [], remove: ['stale'], replace: [] })).toBe('$labels:-stale')
  })

  it('emits = prefix for replace labels', () => {
    expect(serializeLabels({ add: [], remove: [], replace: ['bug'] })).toBe('$labels:=bug')
  })

  it('combines all three action lists in add-remove-replace order', () => {
    const raw = serializeLabels({
      add: ['ci-checked', 'needs-review'],
      remove: ['stale'],
      replace: ['bug'],
    })
    expect(raw).toBe('$labels:+ci-checked,+needs-review,-stale,=bug')
  })

  it('trims whitespace and drops empty labels', () => {
    expect(serializeLabels({ add: ['  spaced  ', ''], remove: ['  '], replace: ['x'] })).toBe(
      '$labels:+spaced,=x',
    )
  })
})

describe('deserializeLabels', () => {
  it('returns empty ops for undefined', () => {
    expect(deserializeLabels(undefined)).toEqual(emptyLabelOps())
  })

  it('returns empty ops for empty string', () => {
    expect(deserializeLabels('')).toEqual(emptyLabelOps())
  })

  it('returns empty ops for non-$labels: strings (safe fallback)', () => {
    // $set: strings belong to a different column and MUST NOT leak in as
    // chips — otherwise the modal would double-serialize them on save.
    expect(deserializeLabels('$set:status=Done')).toEqual(emptyLabelOps())
    expect(deserializeLabels('Done')).toEqual(emptyLabelOps())
  })

  it('parses +/-/= tokens into the matching action list', () => {
    const ops = deserializeLabels('$labels:+ci-checked,+needs-review,-stale,=bug')
    expect(ops.add).toEqual(['ci-checked', 'needs-review'])
    expect(ops.remove).toEqual(['stale'])
    expect(ops.replace).toEqual(['bug'])
  })

  it('ignores unknown prefixes without throwing', () => {
    // Guards against a runtime that ever emits `!foo` or `*bar`; the parser
    // just drops what it doesn't understand instead of exploding.
    const ops = deserializeLabels('$labels:+ok,!huh,*nope,-drop')
    expect(ops.add).toEqual(['ok'])
    expect(ops.remove).toEqual(['drop'])
    expect(ops.replace).toEqual([])
  })

  it('ignores tokens with empty label body', () => {
    expect(deserializeLabels('$labels:+,-,+real')).toEqual({
      add: ['real'],
      remove: [],
      replace: [],
    })
  })
})

describe('label round-trip', () => {
  it('serialize → deserialize → serialize is stable', () => {
    const ops: LabelOps = {
      add: ['ci-checked', 'needs-review'],
      remove: ['stale'],
      replace: [],
    }
    const raw = serializeLabels(ops)
    const parsed = deserializeLabels(raw)
    expect(parsed).toEqual(ops)
    expect(serializeLabels(parsed)).toBe(raw)
  })

  it('deserialize → serialize is stable for the PRD example', () => {
    // The PRD lists both forms — verify each round-trips.
    for (const raw of ['$labels:+ci-checked,+needs-review,-stale', '$labels:=bug']) {
      expect(serializeLabels(deserializeLabels(raw))).toBe(raw)
    }
  })
})

describe('emptyEntry', () => {
  it('initializes all three label buckets as empty LabelOps', () => {
    const e = emptyEntry('my-agent')
    expect(e.onProcessLabels).toEqual(emptyLabelOps())
    expect(e.onFinishLabels).toEqual(emptyLabelOps())
    expect(e.onErrorLabels).toEqual(emptyLabelOps())
  })
})

// ─── Component behaviour ─────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AgentRunnerEntry> = {}): AgentRunnerEntry {
  return { ...emptyEntry('agent-1'), ...overrides }
}

describe('AgentRunnerCard — Labels section', () => {
  it('renders one Labels sub-section per outcome (En proceso / Al terminar / Al fallar)', () => {
    const wrapper = mount(AgentRunnerCard, {
      props: { modelValue: makeEntry(), agentIds: ['agent-1'] },
    })

    const labelSubSections = wrapper.findAll('.labels-section')
    expect(labelSubSections).toHaveLength(3)

    // Each Labels section carries three chip rows (add / remove / replace).
    for (const section of labelSubSections) {
      const rows = section.findAll('.label-action-row')
      expect(rows).toHaveLength(3)
      const actions = rows.map((r) => r.get('.action-label').attributes('data-action'))
      expect(actions).toEqual(['add', 'remove', 'replace'])
    }
  })

  it('renders existing chips for each action from the model', () => {
    const entry = makeEntry({
      onFinishLabels: { add: ['ci-checked'], remove: ['stale'], replace: [] },
    })
    const wrapper = mount(AgentRunnerCard, {
      props: { modelValue: entry, agentIds: ['agent-1'] },
    })

    const finishSection = wrapper.findAll('.labels-section')[1] // onFinish is index 1
    const addChips = finishSection.findAll('.chip[data-action="add"]')
    const removeChips = finishSection.findAll('.chip[data-action="remove"]')
    expect(addChips.map((c) => c.text())).toEqual(['ci-checked ✕'])
    expect(removeChips.map((c) => c.text())).toEqual(['stale ✕'])
  })

  it('commits a chip on Enter and emits update:modelValue with the new label list', async () => {
    const wrapper = mount(AgentRunnerCard, {
      props: { modelValue: makeEntry(), agentIds: ['agent-1'] },
    })

    const input = wrapper.get('[data-labels-input="onFinishLabels.add"]')
    await input.setValue('ci-checked')
    await input.trigger('keydown', { key: 'Enter' })

    const events = wrapper.emitted('update:modelValue')
    expect(events).toBeTruthy()
    const patch = events!.at(-1)?.[0] as AgentRunnerEntry
    expect(patch.onFinishLabels.add).toEqual(['ci-checked'])
    expect(patch.onFinishLabels.remove).toEqual([])
  })

  it('splits comma-separated input into multiple chips', async () => {
    const wrapper = mount(AgentRunnerCard, {
      props: { modelValue: makeEntry(), agentIds: ['agent-1'] },
    })

    const input = wrapper.get('[data-labels-input="onProcessLabels.add"]')
    // Simulate a paste of "a, b, c" then blur to commit — comma keydown also
    // works but @blur is a cleaner assertion here (no per-token flush).
    await input.setValue('a, b, c')
    await input.trigger('blur')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as AgentRunnerEntry
    expect(patch.onProcessLabels.add).toEqual(['a', 'b', 'c'])
  })

  it('removes a chip when its ✕ button is clicked', async () => {
    const entry = makeEntry({
      onErrorLabels: { add: [], remove: [], replace: ['bug', 'regression'] },
    })
    const wrapper = mount(AgentRunnerCard, {
      props: { modelValue: entry, agentIds: ['agent-1'] },
    })

    const errorSection = wrapper.findAll('.labels-section')[2] // onError is index 2
    const replaceChips = errorSection.findAll('.chip[data-action="replace"]')
    expect(replaceChips).toHaveLength(2)
    await replaceChips[0].get('.chip-x').trigger('click')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as AgentRunnerEntry
    expect(patch.onErrorLabels.replace).toEqual(['regression'])
  })
})
