import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SystemPromptEditor, { type SystemPromptBlock } from './SystemPromptEditor.vue'

function makeDataTransfer(text: string): DataTransfer {
  const data: Record<string, string> = {}
  return {
    setData: (fmt: string, value: string) => {
      data[fmt] = value
    },
    getData: (fmt: string) => (fmt === 'text/plain' ? text : (data[fmt] ?? '')),
    dropEffect: 'copy',
    effectAllowed: 'copy',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: ['text/plain'],
    clearData: () => {},
    setDragImage: () => {},
  } as unknown as DataTransfer
}

describe('SystemPromptEditor', () => {
  it('renders one textarea per block', () => {
    const blocks: SystemPromptBlock[] = [
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second block' },
    ]
    const wrapper = mount(SystemPromptEditor, {
      props: { modelValue: blocks },
    })

    const textareas = wrapper.findAll('textarea')
    expect(textareas).toHaveLength(2)
    expect((textareas[0].element as HTMLTextAreaElement).value).toBe('first block')
    expect((textareas[1].element as HTMLTextAreaElement).value).toBe('second block')
  })

  it('inserts dropped placeholder at the cursor position and emits update', async () => {
    const blocks: SystemPromptBlock[] = [
      { type: 'text', text: '0123456789ABCDEFGHIJ' },
      { type: 'text', text: 'unchanged' },
    ]
    const wrapper = mount(SystemPromptEditor, {
      props: { modelValue: blocks },
    })

    const textareaWrapper = wrapper.findAll('textarea')[0]
    const textareaEl = textareaWrapper.element as HTMLTextAreaElement
    textareaEl.selectionStart = 10
    textareaEl.selectionEnd = 10

    const dataTransfer = makeDataTransfer('{task_title}')
    await textareaWrapper.trigger('drop', { dataTransfer })

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const last = emitted![emitted!.length - 1][0] as SystemPromptBlock[]
    expect(last[0].text).toBe('0123456789{task_title}ABCDEFGHIJ')
    expect(last[1].text).toBe('unchanged')
    expect(last[0].text.indexOf('{task_title}')).toBe(10)
  })
})
