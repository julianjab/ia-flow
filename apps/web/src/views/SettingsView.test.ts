import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsView from './SettingsView.vue';
import { useProvidersStore } from '@/stores/providers';

const originalFetch = globalThis.fetch;

describe('SettingsView system prompt save flow', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the updated systemPrompt in the PUT body when Guardar is clicked', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({ url: u, init });
      if (init?.method === 'PUT') {
        return new Response('{}', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          anthropicApi: {
            systemPrompt: [{ type: 'text', text: 'hello ' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const wrapper = mount(SettingsView);
    await flushPromises();

    const store = useProvidersStore();
    expect(store.config.anthropicApi.systemPrompt).toHaveLength(1);

    store.config.anthropicApi.systemPrompt = [
      { type: 'text', text: 'hello {repos}' },
    ];
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="settings-save-button"]').trigger('click');
    await flushPromises();

    const putCall = calls.find((c) => c.init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall!.init!.body as string);
    expect(body.anthropicApi.systemPrompt).toEqual([
      { type: 'text', text: 'hello {repos}' },
    ]);
  });
});
