<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    loading?: boolean;
    error?: string;
    disabled?: boolean;
    placeholder?: string;
    emptyText?: string;
    id?: string;
    maxVisible?: number;
  }>(),
  {
    loading: false,
    error: '',
    disabled: false,
    placeholder: 'Buscar…',
    emptyText: 'Sin resultados',
    id: undefined,
    maxVisible: 200,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const query = ref(props.modelValue ?? '');
const open = ref(false);
const activeIndex = ref(-1);
const rootEl = ref<HTMLDivElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

watch(
  () => props.modelValue,
  (val) => {
    if (val !== query.value) query.value = val ?? '';
  },
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = q
    ? props.options.filter((o) => o.toLowerCase().includes(q))
    : props.options;
  return list.slice(0, props.maxVisible);
});

const showMenu = computed(() => open.value && !props.disabled);

function onInput(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  query.value = value;
  emit('update:modelValue', value);
  open.value = true;
  activeIndex.value = -1;
}

function onFocus() {
  if (!props.disabled) open.value = true;
}

function select(option: string) {
  query.value = option;
  emit('update:modelValue', option);
  open.value = false;
  activeIndex.value = -1;
  inputEl.value?.blur();
}

function clear() {
  query.value = '';
  emit('update:modelValue', '');
  activeIndex.value = -1;
  inputEl.value?.focus();
  open.value = true;
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    open.value = true;
    if (filtered.value.length === 0) return;
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
    scrollActiveIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (filtered.value.length === 0) return;
    activeIndex.value =
      activeIndex.value <= 0 ? filtered.value.length - 1 : activeIndex.value - 1;
    scrollActiveIntoView();
  } else if (e.key === 'Enter') {
    if (activeIndex.value >= 0 && activeIndex.value < filtered.value.length) {
      e.preventDefault();
      select(filtered.value[activeIndex.value]);
    } else {
      open.value = false;
    }
  } else if (e.key === 'Escape') {
    open.value = false;
    activeIndex.value = -1;
  }
}

function scrollActiveIntoView() {
  void nextTick(() => {
    const el = listEl.value?.querySelector<HTMLLIElement>(
      `li[data-idx="${activeIndex.value}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onDocumentClick(e: MouseEvent) {
  if (!rootEl.value) return;
  if (!rootEl.value.contains(e.target as Node)) {
    open.value = false;
    activeIndex.value = -1;
  }
}

watch(open, (v) => {
  if (v) document.addEventListener('mousedown', onDocumentClick);
  else document.removeEventListener('mousedown', onDocumentClick);
});
</script>

<template>
  <div ref="rootEl" class="ac-root">
    <div class="ac-input-wrap" :class="{ 'ac-input-wrap--disabled': disabled }">
      <input
        :id="id"
        ref="inputEl"
        type="text"
        class="ac-input"
        :value="query"
        :placeholder="placeholder"
        :disabled="disabled"
        autocomplete="off"
        @input="onInput"
        @focus="onFocus"
        @keydown="onKeydown"
      />
      <button
        v-if="query && !disabled"
        type="button"
        class="ac-clear"
        aria-label="Limpiar"
        tabindex="-1"
        @click="clear"
      >✕</button>
      <span v-if="loading" class="ac-spinner" aria-hidden="true"></span>
    </div>

    <div v-if="showMenu" class="ac-menu">
      <div v-if="loading" class="ac-state ac-state--loading">Cargando…</div>
      <div v-else-if="error" class="ac-state ac-state--error">{{ error }}</div>
      <div v-else-if="filtered.length === 0" class="ac-state ac-state--empty">
        {{ emptyText }}
      </div>
      <ul v-else ref="listEl" class="ac-list" role="listbox">
        <li
          v-for="(opt, idx) in filtered"
          :key="opt"
          :data-idx="idx"
          class="ac-option"
          :class="{
            'ac-option--active': idx === activeIndex,
            'ac-option--selected': opt === modelValue,
          }"
          role="option"
          :aria-selected="opt === modelValue"
          @mousedown.prevent="select(opt)"
          @mouseenter="activeIndex = idx"
        >
          {{ opt }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ac-root {
  position: relative;
  width: 100%;
}
.ac-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.ac-input {
  width: 100%;
  padding: 0.4rem 2rem 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.875rem;
  background: #fff;
  color: #1e293b;
  outline: none;
  box-sizing: border-box;
}
.ac-input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.ac-input:disabled {
  background: #f9fafb;
  color: #6b7280;
  cursor: not-allowed;
}
.ac-clear {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  padding: 0.2rem;
}
.ac-clear:hover { color: #374151; }
.ac-spinner {
  position: absolute;
  right: 0.55rem;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  border: 2px solid #dbeafe;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: ac-spin 0.7s linear infinite;
}
@keyframes ac-spin { to { transform: translateY(-50%) rotate(360deg); } }

.ac-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 300;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  max-height: 240px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ac-state {
  padding: 0.6rem 0.75rem;
  font-size: 0.8rem;
  color: #6b7280;
}
.ac-state--error { color: #b91c1c; background: #fef2f2; }
.ac-state--empty { color: #9ca3af; font-style: italic; }
.ac-list {
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
  overflow-y: auto;
}
.ac-option {
  padding: 0.4rem 0.75rem;
  font-size: 0.83rem;
  color: #1e293b;
  cursor: pointer;
  line-height: 1.35;
}
.ac-option--active { background: #eff6ff; }
.ac-option--selected {
  color: #1d4ed8;
  font-weight: 600;
}
.ac-option--selected.ac-option--active { background: #dbeafe; }
</style>
