import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StepProviderSelector from './StepProviderSelector.vue';
import type { Provider } from '../stores/providers';

const providers: Provider[] = [
  { id: 'anthropic-api', name: 'Anthropic API' },
  { id: 'tmux-claude', name: 'Tmux Claude' },
  { id: 'iterm-claude', name: 'iTerm Claude' },
];

describe('StepProviderSelector', () => {
  it('renders exactly one <option> per registered provider', () => {
    const wrapper = mount(StepProviderSelector, {
      props: { step: 'implement', providers, modelValue: 'anthropic-api' },
    });
    const options = wrapper.findAll('option');
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.attributes('value'))).toEqual([
      'anthropic-api',
      'tmux-claude',
      'iterm-claude',
    ]);
  });

  it('reflects modelValue on the <select>', () => {
    const wrapper = mount(StepProviderSelector, {
      props: { step: 'implement', providers, modelValue: 'tmux-claude' },
    });
    const select = wrapper.get('select');
    expect((select.element as HTMLSelectElement).value).toBe('tmux-claude');
  });

  it('emits update:modelValue on change', async () => {
    const wrapper = mount(StepProviderSelector, {
      props: { step: 'implement', providers, modelValue: 'anthropic-api' },
    });
    await wrapper.get('select').setValue('iterm-claude');
    const events = wrapper.emitted('update:modelValue');
    expect(events).toBeTruthy();
    expect(events?.[0]).toEqual(['iterm-claude']);
  });
});
