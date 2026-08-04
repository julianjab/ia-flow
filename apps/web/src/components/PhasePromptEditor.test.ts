import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import PhasePromptEditor from './PhasePromptEditor.vue';
import type { PhaseVariable } from '@/api/prompts';

const VARIABLES: PhaseVariable[] = [
  { name: 'task_title', description: 'Task title (issue title).' },
  { name: 'repos', description: 'Comma-separated list of repos.' },
];

function makeProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    step: 'implement' as const,
    prompt: 'hello world',
    defaultPrompt: 'hello world',
    isCustomized: false,
    variables: VARIABLES,
    label: 'Implement',
    ...overrides,
  };
}

describe('PhasePromptEditor', () => {
  it('renders the label and the textarea with the current prompt', () => {
    const wrapper = mount(PhasePromptEditor, { props: makeProps() });

    expect(wrapper.text()).toContain('Implement');
    const textarea = wrapper.get('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('hello world');
  });

  it('emits update:prompt when the textarea changes', async () => {
    const wrapper = mount(PhasePromptEditor, { props: makeProps() });
    const textarea = wrapper.get('textarea');
    (textarea.element as HTMLTextAreaElement).value = 'edited';
    await textarea.trigger('input');

    const emitted = wrapper.emitted('update:prompt');
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual(['edited']);
  });

  it('hides the reset button when isCustomized is false', () => {
    const wrapper = mount(PhasePromptEditor, {
      props: makeProps({ isCustomized: false }),
    });
    expect(
      wrapper.find('[data-testid="phase-prompt-reset-implement"]').exists(),
    ).toBe(false);
  });

  it('emits reset immediately on button click without confirmation', async () => {
    const originalConfirm = globalThis.confirm;
    const confirmSpy = vi.fn(() => true);
    globalThis.confirm = confirmSpy;

    const wrapper = mount(PhasePromptEditor, {
      props: makeProps({ isCustomized: true }),
    });

    const button = wrapper.get('[data-testid="phase-prompt-reset-implement"]');
    await button.trigger('click');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(wrapper.emitted('reset')).toHaveLength(1);
    globalThis.confirm = originalConfirm;
  });

  it('renders one chip per variable with its description as title/tooltip', () => {
    const wrapper = mount(PhasePromptEditor, { props: makeProps() });
    const chips = wrapper.findAll('[data-testid^="phase-variable-chip-implement-"]');
    expect(chips).toHaveLength(VARIABLES.length);
    expect(chips[0].text()).toBe('{task_title}');
    expect(chips[0].attributes('title')).toBe('Task title (issue title).');
    expect(wrapper.text()).toContain('Task title (issue title).');
  });

  it('inserts {name} at the cursor position when a chip is clicked', async () => {
    const wrapper = mount(PhasePromptEditor, {
      props: makeProps({ prompt: '0123456789ABCDEFGHIJ' }),
    });

    const textareaEl = wrapper.get('textarea').element as HTMLTextAreaElement;
    textareaEl.selectionStart = 10;
    textareaEl.selectionEnd = 10;

    await wrapper
      .get('[data-testid="phase-variable-chip-implement-task_title"]')
      .trigger('click');

    const emitted = wrapper.emitted('update:prompt');
    expect(emitted).toBeTruthy();
    const value = emitted![emitted!.length - 1][0] as string;
    expect(value).toBe('0123456789{task_title}ABCDEFGHIJ');
    expect(value.indexOf('{task_title}')).toBe(10);
  });
});
