<script setup lang="ts">
// PermissionsEditor — the issue #58 UI: preset dropdown + category tree +
// bash sub-scopes + raw JSON toggle. Standalone so the AgentEditorModal
// stays under the 500-line ceiling (see apps/web/CLAUDE.md).
//
// Backed by two endpoints served by apps/server/src/routes/tools.ts:
//   GET /api/permission-presets  → the 5 built-in preset bundles
//   GET /api/tools/categories    → the descriptor tree (with bashScopes)
//
// Emits v-model updates for both `presetId` and `permissions[]` so the
// parent (AgentEditorModal) can persist the exact shape the runtime reads.

import { computed, onMounted, ref, watch } from 'vue'
import type { Permission, PermissionPresetId, ToolCategoryDescriptor } from '@ia-flow/shared'

interface PresetDef {
  id: PermissionPresetId
  description: string
  permissions: Permission[]
}

const props = defineProps<{
  presetId: PermissionPresetId | undefined
  permissions: Permission[] | undefined
}>()

const emit = defineEmits<{
  'update:presetId': [id: PermissionPresetId | undefined]
  'update:permissions': [perms: Permission[] | undefined]
}>()

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

const presets = ref<PresetDef[]>([])
const categories = ref<ToolCategoryDescriptor[]>([])
const showRawJson = ref(false)
const rawJsonDraft = ref('')
const rawJsonError = ref('')

const selectedPreset = computed<PermissionPresetId | ''>(() => props.presetId ?? '')
const overrideSet = computed(() => new Set(props.permissions ?? []))

// The `effective` set = preset expansion ∪ overrides. Used to render the
// checkbox tree so the user sees what will actually be granted, not just
// their local overrides.
const effectiveSet = computed(() => {
  const out = new Set<string>()
  if (props.presetId) {
    const preset = presets.value.find((p) => p.id === props.presetId)
    if (preset) for (const p of preset.permissions) out.add(p)
  }
  for (const p of props.permissions ?? []) out.add(p)
  return out
})

onMounted(async () => {
  try {
    const [presetsRes, categoriesRes] = await Promise.all([
      fetch(`${API_BASE}/api/permission-presets`),
      fetch(`${API_BASE}/api/tools/categories`),
    ])
    if (presetsRes.ok) presets.value = (await presetsRes.json()) as PresetDef[]
    if (categoriesRes.ok)
      categories.value = (await categoriesRes.json()) as ToolCategoryDescriptor[]
  } catch {
    // server may not be running — the editor stays empty; the raw JSON
    // toggle is still usable by power users.
  }
})

// Keep the raw JSON textarea in sync when the user isn't editing it.
watch(
  () => props.permissions,
  (perms) => {
    if (!showRawJson.value) rawJsonDraft.value = JSON.stringify(perms ?? [], null, 2)
  },
  { immediate: true },
)

function setPreset(id: string) {
  emit('update:presetId', id ? (id as PermissionPresetId) : undefined)
}

function toggle(perm: Permission) {
  // Overrides are additive — toggling a permission that's already granted
  // by the preset only removes it from the overrides layer; the preset
  // value stays. That's intentional (the AC says overrides only ADD). To
  // truly narrow a preset, the user changes the preset.
  const next = new Set(props.permissions ?? [])
  if (next.has(perm)) next.delete(perm)
  else next.add(perm)
  emit('update:permissions', next.size ? [...next] : undefined)
}

function toggleRawJson() {
  showRawJson.value = !showRawJson.value
  if (showRawJson.value) {
    rawJsonDraft.value = JSON.stringify(props.permissions ?? [], null, 2)
    rawJsonError.value = ''
  }
}

function commitRawJson() {
  try {
    const parsed = JSON.parse(rawJsonDraft.value) as Permission[]
    if (!Array.isArray(parsed)) throw new Error('Debe ser un array')
    emit('update:permissions', parsed.length ? parsed : undefined)
    rawJsonError.value = ''
  } catch (err) {
    rawJsonError.value = String(err)
  }
}
</script>

<template>
  <div class="permissions-editor">
    <!-- Preset dropdown -->
    <div class="field">
      <span class="label">Preset</span>
      <span class="field-hint">
        Elegí un rol base. Los checkboxes de abajo son overrides (agregan
        permisos sobre el preset). Vacío = custom (sólo overrides).
      </span>
      <select
        class="input select"
        :value="selectedPreset"
        @change="setPreset(($event.target as HTMLSelectElement).value)"
      >
        <option value="">— custom (sin preset) —</option>
        <option v-for="p in presets" :key="p.id" :value="p.id" :title="p.description">
          {{ p.id }} — {{ p.description }}
        </option>
      </select>
    </div>

    <!-- Category tree -->
    <div class="field" v-if="categories.length">
      <span class="label">Permisos por categoría</span>
      <span class="field-hint">
        Verde = concedido por el preset. Check adicional = override
        (permiso extra por encima del preset).
      </span>
      <div class="cat-tree">
        <div v-for="cat in categories" :key="cat.id" class="cat-node">
          <label class="cat-row">
            <input
              type="checkbox"
              :checked="effectiveSet.has(cat.id)"
              :disabled="effectiveSet.has(cat.id) && !overrideSet.has(cat.id)"
              @change="toggle(cat.id)"
            />
            <span class="cat-name">{{ cat.id }}</span>
            <span class="cat-desc">{{ cat.description }}</span>
          </label>
          <div v-if="cat.bashScopes?.length" class="bash-scopes">
            <label
              v-for="scope in cat.bashScopes"
              :key="scope.id"
              class="scope-row"
            >
              <input
                type="checkbox"
                :checked="effectiveSet.has(`bash:${scope.id}`)"
                :disabled="
                  effectiveSet.has(`bash:${scope.id}`) &&
                  !overrideSet.has(`bash:${scope.id}`)
                "
                @change="toggle(`bash:${scope.id}` as Permission)"
              />
              <span class="scope-name">bash:{{ scope.id }}</span>
              <span class="scope-desc">{{ scope.description }}</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Raw JSON escape hatch for power users -->
    <div class="field">
      <button type="button" class="btn-raw" @click="toggleRawJson">
        {{ showRawJson ? '▾ Ocultar' : '▸ Ver' }} permissions raw (JSON)
      </button>
      <div v-if="showRawJson" class="raw-panel">
        <textarea v-model="rawJsonDraft" class="raw-input" rows="8" spellcheck="false"></textarea>
        <div class="raw-actions">
          <button type="button" class="btn-apply" @click="commitRawJson">Aplicar JSON</button>
          <span v-if="rawJsonError" class="raw-err">{{ rawJsonError }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.permissions-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.label {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--fg-dim);
  letter-spacing: 0.06em;
}
.field-hint {
  font-size: 11px;
  color: var(--fg-dim);
}
.input.select {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 4px 6px;
  font-family: var(--mono);
  font-size: 12px;
}
.cat-tree {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  padding: 6px 8px;
  gap: 6px;
}
.cat-row,
.scope-row {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
}
.cat-name,
.scope-name {
  color: var(--fg);
  min-width: 12ch;
}
.cat-desc,
.scope-desc {
  color: var(--fg-dim);
}
.bash-scopes {
  margin-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 1px solid var(--border);
  padding-left: 8px;
}
.btn-raw {
  align-self: flex-start;
  background: transparent;
  color: var(--fg-dim);
  border: none;
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 0;
}
.btn-raw:hover {
  color: var(--fg);
}
.raw-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.raw-input {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 6px;
  font-family: var(--mono);
  font-size: 11px;
  resize: vertical;
}
.raw-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.btn-apply {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 3px 8px;
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}
.raw-err {
  color: var(--ansi-red);
  font-size: 11px;
  font-family: var(--mono);
}
</style>
