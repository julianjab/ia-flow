import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { setActivePinia, createPinia } from 'pinia';
import axios from 'axios';
import type { ProjectConfig } from '@ia-flow/shared';
import { useProjectConfigStore } from './project-config';

const snap = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const baseConfig: ProjectConfig = {
  project: { name: 'ia-flow', language: 'typescript', defaultOwner: 'la-haus' },
  agents: [],
  statuses: [],
};

const originalGet = axios.get;
const originalPut = axios.put;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  axios.get = originalGet;
  axios.put = originalPut;
});

describe('project-config store', () => {
  describe('fetch', () => {
    it('hidrata config y raw, limpia loading', async () => {
      const calls: string[] = [];
      axios.get = (async (url: string) => {
        calls.push(url);
        return { data: { config: baseConfig, raw: 'yaml: content' } };
      }) as any;

      const store = useProjectConfigStore();
      expect(store.loading).toBe(false);

      await store.fetch();

      expect(calls).toEqual(['/api/project-config']);
      expect(snap(store.config)).toEqual(baseConfig);
      expect(store.raw).toBe('yaml: content');
      expect(store.loading).toBe(false);
    });

    it('limpia loading aunque fetch falle', async () => {
      axios.get = (async () => { throw new Error('network error') }) as any;

      const store = useProjectConfigStore();
      await expect(store.fetch()).rejects.toThrow('network error');
      expect(store.loading).toBe(false);
    });

    it('acepta config null en la respuesta', async () => {
      axios.get = (async () => ({ data: { config: null, raw: '' } })) as any;

      const store = useProjectConfigStore();
      await store.fetch();
      expect(store.config).toBeNull();
      expect(store.raw).toBe('');
    });
  });

  describe('save', () => {
    it('llama PUT y luego re-fetcha, limpia saving', async () => {
      const putCalls: { url: string; body: unknown }[] = [];
      const getCalls: string[] = [];

      axios.put = (async (url: string, body: unknown) => {
        putCalls.push({ url, body });
        return { data: {} };
      }) as any;

      axios.get = (async (url: string) => {
        getCalls.push(url);
        return { data: { config: baseConfig, raw: 'updated' } };
      }) as any;

      const store = useProjectConfigStore();
      expect(store.saving).toBe(false);

      await store.save(baseConfig);

      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].url).toBe('/api/project-config');
      expect(putCalls[0].body).toEqual({ config: baseConfig });
      expect(getCalls).toEqual(['/api/project-config']);
      expect(store.saving).toBe(false);
      expect(store.raw).toBe('updated');
    });

    it('limpia saving aunque PUT falle', async () => {
      axios.put = (async () => { throw new Error('save failed') }) as any;

      const store = useProjectConfigStore();
      await expect(store.save(baseConfig)).rejects.toThrow('save failed');
      expect(store.saving).toBe(false);
    });
  });

  describe('saveRaw', () => {
    it('llama PUT /raw y luego re-fetcha', async () => {
      const putCalls: { url: string; body: unknown }[] = [];

      axios.put = (async (url: string, body: unknown) => {
        putCalls.push({ url, body });
        return { data: {} };
      }) as any;

      axios.get = (async () => ({
        data: { config: baseConfig, raw: 'raw-yaml' },
      })) as any;

      const store = useProjectConfigStore();
      await store.saveRaw('raw-yaml');

      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].url).toBe('/api/project-config/raw');
      expect(putCalls[0].body).toEqual({ raw: 'raw-yaml' });
      expect(store.raw).toBe('raw-yaml');
      expect(store.saving).toBe(false);
    });

    it('limpia saving aunque PUT /raw falle', async () => {
      axios.put = (async () => { throw new Error('raw save failed') }) as any;

      const store = useProjectConfigStore();
      await expect(store.saveRaw('bad-yaml')).rejects.toThrow('raw save failed');
      expect(store.saving).toBe(false);
    });
  });
});
