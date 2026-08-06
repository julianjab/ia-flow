import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SystemPromptForm from './SystemPromptForm.vue';
import PromptField from './PromptField.vue';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('SystemPromptForm', () => {
  it('renders the reusable PromptField for the prompt text', () => {
    const wrapper = mount(SystemPromptForm, {
      props: { modelValue: { name: 'Foo', text: 'hello' } },
    });
    expect(wrapper.findComponent(PromptField).exists()).toBe(true);
    expect(wrapper.findComponent(PromptField).props('modelValue')).toBe('hello');
  });

  it('emits update:modelValue when the name input changes', async () => {
    const wrapper = mount(SystemPromptForm, {
      props: { modelValue: { name: 'Foo', text: 'hello' } },
    });
    const input = wrapper.get('input');
    await input.setValue('Bar');
    const events = wrapper.emitted('update:modelValue');
    expect(events).toBeTruthy();
    expect(events!.at(-1)?.[0]).toEqual({ name: 'Bar', text: 'hello' });
  });

  it('propagates PromptField updates via v-model', async () => {
    const wrapper = mount(SystemPromptForm, {
      props: { modelValue: { name: 'Foo', text: 'hello' } },
    });
    await wrapper.findComponent(PromptField).vm.$emit('update:modelValue', 'world');
    const events = wrapper.emitted('update:modelValue');
    expect(events!.at(-1)?.[0]).toEqual({ name: 'Foo', text: 'world' });
  });

  it('emits save and cancel from action buttons', async () => {
    const wrapper = mount(SystemPromptForm, {
      props: { modelValue: { name: 'Foo', text: 'hello' } },
    });
    await wrapper.get('.btn-cancel-sm').trigger('click');
    await wrapper.get('.btn-save-sm').trigger('click');
    expect(wrapper.emitted('cancel')).toBeTruthy();
    expect(wrapper.emitted('save')).toBeTruthy();
  });

  it('shows the id hint when provided', () => {
    const wrapper = mount(SystemPromptForm, {
      props: { modelValue: { name: 'Foo', text: 'x' }, idHint: 'foo' },
    });
    expect(wrapper.text()).toContain('foo');
  });
});
