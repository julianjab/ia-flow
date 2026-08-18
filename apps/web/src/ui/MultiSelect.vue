<script setup lang="ts">
// Generic multiselect with autocomplete — sibling of AutocompleteSelect for
// the string[] case: filtered dropdown, keyboard nav, removable chips, and
// (optionally) a "Crear «foo»" affordance for values not yet in `options`.
// No domain knowledge: OutcomesEditor feeds it the Labels catalog, but
// nothing here knows about labels/agents/outcomes.

import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    options: string[]
    placeholder?: string
    allowCustom?: boolean
    disabled?: boolean
  }>(),
  {
    placeholder: 'Buscar…',
    allowCustom: true,
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const query = ref('')
const open = ref(false)
const activeIndex = ref(-1)
const rootEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLUListElement | null>(null)

// Candidate options: catalog minus whatever is already selected, filtered by
// the in-progress query. A trailing synthetic "custom" entry is appended
// when the query doesn't match anything and allowCustom is on.
const filteredOptions = computed(() => {
  const q = query.value.trim().toLowerCase()
  const selected = new Set(props.modelValue)
  const pool = props.options.filter((o) => !selected.has(o))
  return q ? pool.filter((o) => o.toLowerCase().includes(q)) : pool
})

const trimmedQuery = computed(() => query.value.trim())

const canCreateCustom = computed(() => {
  if (!props.allowCustom || !trimmedQuery.value) return false
  if (props.modelValue.includes(trimmedQuery.value)) return false
  return !props.options.some(
    (o) => o.toLowerCase() === trimmedQuery.value.toLowerCase(),
  )
})

// Flat list driving keyboard nav — real options first, custom entry last.
type Entry = { kind: 'option'; value: string } | { kind: 'custom'; value: string }
const entries = computed<Entry[]>(() => {
  const list: Entry[] = filteredOptions.value.map((value) => ({ kind: 'option', value }))
  if (canCreateCustom.value) list.push({ kind: 'custom', value: trimmedQuery.value })
  return list
})

const showMenu = computed(() => open.value && !props.disabled)

function addValue(value: string) {
  const v = value.trim()
  if (!v || props.disabled) return
  if (props.modelValue.includes(v)) return
  emit('update:modelValue', [...props.modelValue, v])
  query.value = ''
  activeIndex.value = -1
  void nextTick(() => inputEl.value?.focus())
}

function removeValue(value: string) {
  if (props.disabled) return
  emit('update:modelValue', props.modelValue.filter((v) => v !== value))
}

function removeLast() {
  if (props.disabled || !props.modelValue.length) return
  removeValue(props.modelValue[props.modelValue.length - 1])
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value
  open.value = true
  activeIndex.value = -1
}

function onFocus() {
  if (!props.disabled) open.value = true
}

function scrollActiveIntoView() {
  void nextTick(() => {
    const el = listEl.value?.querySelector<HTMLLIElement>(`li[data-idx="${activeIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    open.value = true
    if (!entries.value.length) return
    activeIndex.value = (activeIndex.value + 1) % entries.value.length
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!entries.value.length) return
    activeIndex.value = activeIndex.value <= 0 ? entries.value.length - 1 : activeIndex.value - 1
    scrollActiveIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (activeIndex.value >= 0 && activeIndex.value < entries.value.length) {
      addValue(entries.value[activeIndex.value].value)
    } else if (canCreateCustom.value) {
      addValue(trimmedQuery.value)
    }
  } else if (e.key === 'Escape') {
    open.value = false
    activeIndex.value = -1
  } else if (e.key === 'Backspace' && query.value === '') {
    removeLast()
  }
}

function onDocumentClick(e: MouseEvent) {
  if (!rootEl.value) return
  if (!rootEl.value.contains(e.target as Node)) {
    open.value = false
    activeIndex.value = -1
  }
}

watch(open, (v) => {
  if (v) document.addEventListener('mousedown', onDocumentClick)
  else document.removeEventListener('mousedown', onDocumentClick)
})
</script>

<template>
  <div ref="rootEl" class="ms-root">
    <div class="ms-field" :class="{ 'ms-field--disabled': disabled }">
      <span
        v-for="value in modelValue"
        :key="value"
        class="ms-chip"
      >
        {{ value }}
        <button
          type="button"
          class="ms-chip-x"
          :aria-label="`Quitar ${value}`"
          :disabled="disabled"
          @click="removeValue(value)"
        >✕</button>
      </span>
      <input
        ref="inputEl"
        type="text"
        class="ms-input"
        :value="query"
        :placeholder="modelValue.length ? '' : placeholder"
        :disabled="disabled"
        autocomplete="off"
        @input="onInput"
        @focus="onFocus"
        @keydown="onKeydown"
      />
    </div>

    <div v-if="showMenu" class="ms-menu">
      <div v-if="!entries.length" class="ms-state">Sin resultados</div>
      <ul v-else ref="listEl" class="ms-list" role="listbox">
        <li
          v-for="(entry, idx) in entries"
          :key="entry.kind === 'custom' ? `__custom__${entry.value}` : entry.value"
          :data-idx="idx"
          class="ms-option"
          :class="{ 'ms-option--active': idx === activeIndex, 'ms-option--custom': entry.kind === 'custom' }"
          role="option"
          :aria-selected="false"
          @mousedown.prevent="addValue(entry.value)"
          @mouseenter="activeIndex = idx"
        >
          <template v-if="entry.kind === 'custom'">Crear «{{ entry.value }}»</template>
          <template v-else>{{ entry.value }}</template>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ms-root {
  position: relative;
  width: 100%;
}

.ms-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  min-height: var(--row-h);
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
}
.ms-field--disabled {
  background: var(--panel-alt);
  cursor: not-allowed;
}

.ms-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  height: var(--row-h);
  line-height: var(--row-h);
  padding: 0 0.5ch;
  background: var(--panel-hi);
  color: var(--info);
  border: 1px solid var(--info);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
}
.ms-chip-x {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0;
  line-height: 1;
  opacity: 0.7;
}
.ms-chip-x:hover { opacity: 1; }
.ms-chip-x:disabled { cursor: not-allowed; }

.ms-input {
  flex: 1 1 6rem;
  min-width: 6rem;
  border: none;
  outline: none;
  background: transparent;
  padding: 0 0.25rem;
  height: var(--row-h);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  color: var(--fg);
}
.ms-input:disabled { cursor: not-allowed; }

.ms-menu {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  max-height: 220px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ms-state {
  padding: 0.4rem 0.6rem;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  font-style: italic;
}
.ms-list {
  list-style: none;
  margin: 0;
  padding: 0.2rem 0;
  overflow-y: auto;
}
.ms-option {
  padding: 0 0.6rem;
  height: var(--row-h);
  line-height: var(--row-h);
  font-size: var(--fs-body-sm);
  color: var(--fg);
  cursor: pointer;
}
.ms-option--active {
  background: var(--accent);
  color: var(--panel);
}
.ms-option--custom {
  color: var(--accent);
  font-style: italic;
}
.ms-option--custom.ms-option--active {
  background: var(--accent);
  color: var(--panel);
}
</style>
