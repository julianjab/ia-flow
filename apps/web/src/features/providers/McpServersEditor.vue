<script setup lang="ts">
// Shared editor for `mcpServers` maps used by both anthropic-api and terminal
// providers. Emits `update:modelValue` with the full servers record whenever
// the user tweaks anything. Enforces required fields per variant before
// pushing an update — invalid entries are held locally until fixed.
import { ref, watch } from 'vue';
import type { McpServerConfig, McpServers } from '@ia-flow/shared';

type ServerType = 'stdio' | 'http' | 'sse';

interface EditableEntry {
  name: string;
  type: ServerType;
  // stdio
  command: string;
  argsText: string;
  envText: string;
  // http/sse
  url: string;
  authorizationToken: string;
  headersText: string;
}

const props = defineProps<{
  modelValue: McpServers | undefined;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: McpServers): void;
}>();

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function argsToText(args: string[] | undefined): string {
  return (args ?? []).join('\n');
}

function textToArgs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function serversToEntries(servers: McpServers | undefined): EditableEntry[] {
  return Object.entries(servers ?? {}).map(([name, cfg]) => {
    if ('url' in cfg) {
      return {
        name,
        type: (cfg.type ?? 'http') as ServerType,
        command: '',
        argsText: '',
        envText: '',
        url: cfg.url,
        authorizationToken: cfg.authorizationToken ?? '',
        headersText: envToText(cfg.headers),
      };
    }
    return {
      name,
      type: 'stdio',
      command: cfg.command,
      argsText: argsToText(cfg.args),
      envText: envToText(cfg.env),
      url: '',
      authorizationToken: '',
      headersText: '',
    };
  });
}

const entries = ref<EditableEntry[]>(serversToEntries(props.modelValue));

watch(
  () => props.modelValue,
  (next) => {
    entries.value = serversToEntries(next);
  },
  { deep: true },
);

function isEntryValid(e: EditableEntry): boolean {
  if (!e.name.trim()) return false;
  if (e.type === 'stdio') return e.command.trim().length > 0;
  return e.url.trim().length > 0;
}

function entryToServer(e: EditableEntry): McpServerConfig | null {
  if (!isEntryValid(e)) return null;
  if (e.type === 'stdio') {
    const cfg: McpServerConfig = { type: 'stdio', command: e.command.trim() };
    const args = textToArgs(e.argsText);
    if (args.length) (cfg as { args?: string[] }).args = args;
    const env = textToEnv(e.envText);
    if (Object.keys(env).length) (cfg as { env?: Record<string, string> }).env = env;
    return cfg;
  }
  const cfg: McpServerConfig = { type: e.type, url: e.url.trim() };
  if (e.authorizationToken.trim())
    (cfg as { authorizationToken?: string }).authorizationToken = e.authorizationToken.trim();
  const headers = textToEnv(e.headersText);
  if (Object.keys(headers).length)
    (cfg as { headers?: Record<string, string> }).headers = headers;
  return cfg;
}

function emitChange() {
  const out: McpServers = {};
  for (const e of entries.value) {
    const cfg = entryToServer(e);
    if (!cfg) continue;
    out[e.name.trim()] = cfg;
  }
  emit('update:modelValue', out);
}

function addEntry() {
  entries.value.push({
    name: '',
    type: 'http',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    authorizationToken: '',
    headersText: '',
  });
}

function removeEntry(i: number) {
  entries.value.splice(i, 1);
  emitChange();
}
</script>

<template>
  <div class="mcp-editor">
    <span class="group-hint">
      Servidores MCP disponibles para el provider. Los <code>stdio</code> solo aplican a terminal
      providers; <code>http</code>/<code>sse</code> se envían también al connector remoto de la
      Anthropic API.
    </span>

    <div v-for="(entry, i) in entries" :key="i" class="mcp-row">
      <div class="mcp-line">
        <input
          class="mcp-input mcp-name"
          placeholder="nombre (ej. docs)"
          :value="entry.name"
          @input="entry.name = ($event.target as HTMLInputElement).value; emitChange()"
        />
        <select
          class="mcp-input mcp-type"
          :value="entry.type"
          @change="entry.type = ($event.target as HTMLSelectElement).value as ServerType; emitChange()"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
        <button type="button" class="btn-remove" title="Eliminar" @click="removeEntry(i)">✕</button>
      </div>

      <template v-if="entry.type === 'stdio'">
        <input
          class="mcp-input"
          placeholder="command (requerido, ej. node)"
          :value="entry.command"
          @input="entry.command = ($event.target as HTMLInputElement).value; emitChange()"
        />
        <textarea
          class="mcp-input mcp-multi"
          placeholder="args (uno por línea)"
          :value="entry.argsText"
          @input="entry.argsText = ($event.target as HTMLTextAreaElement).value; emitChange()"
        />
        <textarea
          class="mcp-input mcp-multi"
          placeholder="env (KEY=value por línea)"
          :value="entry.envText"
          @input="entry.envText = ($event.target as HTMLTextAreaElement).value; emitChange()"
        />
      </template>

      <template v-else>
        <input
          class="mcp-input"
          placeholder="url (requerido, ej. https://mcp.example/docs)"
          :value="entry.url"
          @input="entry.url = ($event.target as HTMLInputElement).value; emitChange()"
        />
        <input
          class="mcp-input"
          placeholder="authorization token (opcional)"
          :value="entry.authorizationToken"
          @input="entry.authorizationToken = ($event.target as HTMLInputElement).value; emitChange()"
        />
        <textarea
          class="mcp-input mcp-multi"
          placeholder="headers (KEY=value por línea)"
          :value="entry.headersText"
          @input="entry.headersText = ($event.target as HTMLTextAreaElement).value; emitChange()"
        />
      </template>

      <span v-if="!isEntryValid(entry)" class="mcp-invalid">
        Falta {{ !entry.name.trim() ? 'nombre' : entry.type === 'stdio' ? 'command' : 'url' }} —
        esta entrada no se guardará.
      </span>
    </div>

    <button type="button" class="btn-add-mcp" @click="addEntry">+ Agregar MCP server</button>
  </div>
</template>

<style scoped>
.mcp-editor { display: flex; flex-direction: column; gap: 0.6rem; }
.group-hint { font-size: 0.72rem; color: #6b7280; }
.group-hint code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.7rem; }
.mcp-row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fafafa;
}
.mcp-line { display: flex; align-items: center; gap: 0.35rem; }
.mcp-input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
  font-family: monospace;
  background: #fff;
  color: #111827;
  outline: none;
}
.mcp-input:focus { border-color: #6366f1; }
.mcp-name { flex: 1; }
.mcp-type { width: 6rem; }
.mcp-multi { min-height: 3rem; resize: vertical; }
.btn-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: #9ca3af;
  font-size: 0.75rem;
  padding: 0.2rem 0.3rem;
  border-radius: 4px;
  line-height: 1;
}
.btn-remove:hover { color: #ef4444; }
.btn-add-mcp {
  align-self: flex-start;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  color: #6b7280;
  cursor: pointer;
}
.btn-add-mcp:hover { border-color: #6366f1; color: #6366f1; }
.mcp-invalid { font-size: 0.7rem; color: #b45309; }
</style>
