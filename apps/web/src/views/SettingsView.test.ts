import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsView from './SettingsView.vue';
import type { ProviderConfig } from '../stores/providers';

// Ensure Teleport target exists.
function ensureToastContainer(): void {
  if (!document.getElementById('toast-container')) {
    const el = document.createElement('div');
    el.id = 'toast-container';
    document.body.appendChild(el);
  }
}

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    steps: {
      'refine-functional': 'anthropic-api',
      'refine-technical': 'anthropic-api',
      implement: 'anthropic-api',
    },
    anthropicApi: {
      model: 'claude-opus-4-7',
      responseLanguage: 'es',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      stream: true,
      systemPrompt: [{ type: 'text', text: 'hello {task_title}' }],
      anthropicVersion: '2023-06-01',
      anthropicBeta: ['beta-a'],
    },
    ...overrides,
  };
}

function stubFetchOk(config: ProviderConfig, saveResponse?: ProviderConfig) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify(saveResponse ?? config), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        providers: [
          { id: 'anthropic-api' },
          { id: 'tmux-claude' },
          { id: 'iterm-claude' },
        ],
        config,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  setActivePinia(createPinia());
  ensureToastContainer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('SettingsView', () => {
  it('shows active config on initial load', async () => {
    const config = makeConfig();
    stubFetchOk(config);
    const wrapper = mount(SettingsView);
    await flushPromises();

    const selects = wrapper.findAll('select[data-step]');
    expect(selects).toHaveLength(3);
    for (const sel of selects) {
      expect((sel.element as HTMLSelectElement).value).toBe('anthropic-api');
    }

    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe('claude-opus-4-7');
    expect((wrapper.get('#anthropic-response-language').element as HTMLInputElement).value).toBe('es');
    expect((wrapper.get('#anthropic-thinking-type').element as HTMLSelectElement).value).toBe('enabled');
    expect((wrapper.get('#anthropic-thinking-budget').element as HTMLInputElement).value).toBe('8000');
    expect((wrapper.get('#anthropic-stream').element as HTMLInputElement).checked).toBe(true);
  });

  it('save dispatches PUT with full body and shows success toast', async () => {
    const config = makeConfig();
    const { calls } = stubFetchOk(config);
    const wrapper = mount(SettingsView);
    await flushPromises();

    const implementSelect = wrapper.get('select[data-step="implement"]');
    await implementSelect.setValue('iterm-claude');

    const modelInput = wrapper.get('#anthropic-model');
    await modelInput.setValue('claude-sonnet-4-6');

    await wrapper.get('.save-button').trigger('click');
    await flushPromises();

    const putCall = calls.find((c) => c.init?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall!.init!.body as string);
    expect(body.steps.implement).toBe('iterm-claude');
    expect(body.steps['refine-functional']).toBe('anthropic-api');
    expect(body.anthropicApi.model).toBe('claude-sonnet-4-6');
    // Preserved out-of-scope fields.
    expect(body.anthropicApi.systemPrompt).toEqual([{ type: 'text', text: 'hello {task_title}' }]);
    expect(body.anthropicApi.anthropicVersion).toBe('2023-06-01');

    const toast = document.querySelector('.toast-success');
    expect(toast).toBeTruthy();
  });

  it('preserves edits when save fails', async () => {
    const config = makeConfig();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response('bad', { status: 400 });
      return new Response(
        JSON.stringify({
          providers: [
            { id: 'anthropic-api' },
            { id: 'tmux-claude' },
            { id: 'iterm-claude' },
          ],
          config,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(SettingsView);
    await flushPromises();

    await wrapper.get('#anthropic-model').setValue('edited-model');
    await wrapper.get('select[data-step="implement"]').setValue('tmux-claude');

    await wrapper.get('.save-button').trigger('click');
    await flushPromises();

    // Values must remain edited (not reset).
    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe('edited-model');
    expect(
      (wrapper.get('select[data-step="implement"]').element as HTMLSelectElement).value,
    ).toBe('tmux-claude');

    const errorToast = document.querySelector('.toast-error');
    expect(errorToast).toBeTruthy();
  });

  it('re-hydrates persisted values on remount (reload)', async () => {
    const config = makeConfig({
      steps: {
        'refine-functional': 'tmux-claude',
        'refine-technical': 'iterm-claude',
        implement: 'iterm-claude',
      },
    });
    stubFetchOk(config);

    setActivePinia(createPinia());
    const wrapper = mount(SettingsView);
    await flushPromises();

    expect(
      (wrapper.get('select[data-step="refine-functional"]').element as HTMLSelectElement).value,
    ).toBe('tmux-claude');
    expect(
      (wrapper.get('select[data-step="implement"]').element as HTMLSelectElement).value,
    ).toBe('iterm-claude');
    expect((wrapper.get('#anthropic-model').element as HTMLInputElement).value).toBe('claude-opus-4-7');
  });
});
