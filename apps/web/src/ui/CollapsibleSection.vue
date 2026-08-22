<script setup lang="ts">
// Generic collapsible section — accordion building block. No domain
// knowledge: any feature can use it to group a chunk of a long form behind
// a header + summary. See AgentEditorModal for the reference consumer.

import { ref, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    summary?: string
    defaultOpen?: boolean
    // 'danger' pinta el summary como error visible sin tener que abrir el
    // panel — para estados como "prompt vacío" que hoy solo se notan
    // leyendo el texto hasta el final. Ver AgentEditorModal.
    summaryVariant?: 'default' | 'danger'
  }>(),
  {
    summary: undefined,
    defaultOpen: false,
    summaryVariant: 'default',
  },
)

const open = ref(props.defaultOpen)
const headerId = `cs-header-${useId()}`
const panelId = `cs-panel-${useId()}`

function toggle() {
  open.value = !open.value
}

// Lets a parent force this section open (e.g. a validation error landed
// inside a collapsed panel) without turning `open` into a controlled prop —
// the section still owns its own collapse/expand state day to day.
function forceOpen() {
  open.value = true
}

defineExpose({ open, forceOpen })
</script>

<template>
  <section class="cs">
    <button
      :id="headerId"
      type="button"
      class="cs-header"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="toggle"
    >
      <span class="cs-chevron" :class="{ 'cs-chevron--open': open }" aria-hidden="true">▸</span>
      <span class="cs-title">{{ title }}</span>
      <span
        v-if="!open && summary"
        class="cs-summary"
        :class="{ 'cs-summary--danger': summaryVariant === 'danger' }"
      >{{ summary }}</span>
    </button>
    <div
      v-show="open"
      :id="panelId"
      class="cs-panel"
      role="region"
      :aria-labelledby="headerId"
    >
      <slot />
    </div>
  </section>
</template>

<style scoped>
.cs {
  border: 1px solid var(--border);
  background: var(--panel-alt);
}

.cs-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  height: var(--row-h);
  padding: 0 0.75ch;
  background: var(--panel-hi);
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  letter-spacing: var(--tracking-hd);
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
}
.cs-header:hover { color: var(--accent); }
.cs-header:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.cs-chevron {
  flex-shrink: 0;
  display: inline-block;
  color: var(--fg-dim);
  transition: transform 0.1s;
}
.cs-chevron--open { transform: rotate(90deg); }

.cs-title { flex-shrink: 0; }

.cs-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  text-transform: none;
  letter-spacing: normal;
  font-size: var(--fs-body-sm);
  text-align: right;
}
.cs-summary--danger {
  color: var(--danger);
  font-weight: 600;
}

.cs-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
}
</style>
