<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getRepoMappings } from '@/features/repos/api';

// Multi-select with chips backed by the DB `repos` table (mapped repos).
// Ad-hoc values are allowed — anything typed that doesn't match an existing
// repo becomes a chip anyway, marked visually so the user knows it's not
// registered yet. Emits/receives a plain string[] via v-model.

const props = defineProps<{
  modelValue: string[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void;
}>();

const knownRepos = ref<string[]>([]);
const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const focused = ref(false);
const activeIndex = ref(-1);

onMounted(async () => {
  try {
    const rows = await getRepoMappings();
    knownRepos.value = rows.map((r) => r.name).sort();
  } catch {
    knownRepos.value = [];
  }
});

const selected = computed(() => props.modelValue);

// Suggestions: known repos not already selected, matching the query.
const suggestions = computed(() => {
  const q = query.value.trim().toLowerCase();
  const already = new Set(selected.value.map((n) => n.toLowerCase()));
  return knownRepos.value
    .filter((r) => !already.has(r.toLowerCase()))
    .filter((r) => !q || r.toLowerCase().includes(q))
    .slice(0, 20);
});

// Whether the exact typed value would be an ad-hoc chip (not a known repo).
const isAdHoc = computed(() => {
  const q = query.value.trim();
  if (!q) return false;
  return !knownRepos.value.some((r) => r.toLowerCase() === q.toLowerCase());
});

function addChip(name: string) {
  const clean = name.trim();
  if (!clean) return;
  if (selected.value.some((n) => n.toLowerCase() === clean.toLowerCase())) return;
  emit('update:modelValue', [...selected.value, clean]);
  query.value = '';
  activeIndex.value = -1;
}

function removeChip(name: string) {
  emit(
    'update:modelValue',
    selected.value.filter((n) => n !== name),
  );
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIndex.value >= 0 && suggestions.value[activeIndex.value]) {
      addChip(suggestions.value[activeIndex.value]);
    } else if (query.value.trim()) {
      addChip(query.value);
    }
  } else if (e.key === ',') {
    e.preventDefault();
    if (query.value.trim()) addChip(query.value);
  } else if (e.key === 'Backspace' && !query.value && selected.value.length) {
    removeChip(selected.value[selected.value.length - 1]);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, suggestions.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, -1);
  } else if (e.key === 'Escape') {
    query.value = '';
    activeIndex.value = -1;
    inputRef.value?.blur();
  }
}

function onBlur() {
  // Delay so a click on a suggestion still fires.
  setTimeout(() => { focused.value = false; }, 120);
}

function isKnown(name: string): boolean {
  return knownRepos.value.some((r) => r.toLowerCase() === name.toLowerCase());
}
</script>

<template>
  <div class="rms" :class="{ 'rms--focused': focused }" @click="inputRef?.focus()">
    <span
      v-for="name in selected"
      :key="name"
      class="rms-chip"
      :class="{ 'rms-chip--adhoc': !isKnown(name) }"
      :title="isKnown(name) ? name : `${name} (no registrado en Repos)`"
    >
      {{ name }}
      <button
        type="button"
        class="rms-chip__remove"
        aria-label="Quitar"
        @click.stop="removeChip(name)"
      >×</button>
    </span>

    <input
      ref="inputRef"
      v-model="query"
      class="rms-input"
      :placeholder="selected.length ? '' : (placeholder ?? 'Buscar o escribir repo…')"
      @focus="focused = true"
      @blur="onBlur"
      @keydown="onKeydown"
    />

    <ul
      v-if="focused && (suggestions.length || (isAdHoc && query.trim()))"
      class="rms-dropdown"
    >
      <li
        v-for="(name, i) in suggestions"
        :key="name"
        :class="['rms-option', { 'rms-option--active': i === activeIndex }]"
        @mousedown.prevent="addChip(name)"
        @mouseenter="activeIndex = i"
      >
        <span class="rms-option__name">{{ name }}</span>
        <span class="rms-option__hint">registrado</span>
      </li>
      <li
        v-if="isAdHoc"
        :class="['rms-option', 'rms-option--adhoc', { 'rms-option--active': activeIndex === suggestions.length }]"
        @mousedown.prevent="addChip(query)"
        @mouseenter="activeIndex = suggestions.length"
      >
        <span class="rms-option__name">Agregar “{{ query.trim() }}”</span>
        <span class="rms-option__hint">no registrado</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.rms {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0.35rem 0.5rem;
  min-height: 2rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  cursor: text;
}
.rms--focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
}
.rms-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  background: var(--panel-hi);
  color: var(--accent);
  border: 1px solid var(--info);
  border-radius: 999px;
  font-size: 0.8rem;
  line-height: 1.2;
}
.rms-chip--adhoc {
  background: var(--yellow-bg);
  color: var(--warn);
  border-color: var(--warn);
}
.rms-chip__remove {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 0.1rem;
}
.rms-input {
  flex: 1;
  min-width: 8rem;
  border: none;
  outline: none;
  background: transparent;
  font-size: 0.9rem;
  padding: 0.15rem 0;
}
.rms-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
  z-index: 20;
  max-height: 240px;
  overflow-y: auto;
}
.rms-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.rms-option--active { background: var(--panel-hi); }
.rms-option__name { color: var(--fg); }
.rms-option__hint {
  color: var(--fg-dim);
  font-size: 0.7rem;
}
.rms-option--adhoc .rms-option__name { color: var(--warn); }
</style>
