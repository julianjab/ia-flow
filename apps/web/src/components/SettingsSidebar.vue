<script setup lang="ts" generic="TabId extends string">
import { computed } from 'vue';

interface TabItem {
  id: TabId;
  label: string;
  icon: string;
  group: string;
}

const props = defineProps<{
  tabs: TabItem[];
  activeTab: TabId;
  groupLabels?: Record<string, string>;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:activeTab', tab: TabId): void;
  (e: 'toggle-collapsed'): void;
}>();

const grouped = computed(() => {
  const order: string[] = [];
  const map = new Map<string, TabItem[]>();
  for (const t of props.tabs) {
    if (!map.has(t.group)) {
      map.set(t.group, []);
      order.push(t.group);
    }
    map.get(t.group)!.push(t);
  }
  return order.map((g) => ({ group: g, items: map.get(g)! }));
});

function labelFor(group: string): string {
  return props.groupLabels?.[group] ?? group;
}

function select(tab: TabId) {
  if (tab !== props.activeTab) emit('update:activeTab', tab);
}

function onKey(e: KeyboardEvent, tab: TabId) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    select(tab);
  }
}
</script>

<template>
  <div class="tui-sidebar-root" :class="{ 'tui-sidebar-root--open': !collapsed }">
    <div
      v-if="!collapsed"
      class="tui-sidebar__backdrop"
      aria-hidden="true"
      @click="emit('toggle-collapsed')"
    />
    <aside
      class="tui-sidebar"
      :class="{ 'tui-sidebar--collapsed': collapsed }"
      role="navigation"
      aria-label="Sections"
    >
      <button
        type="button"
        class="tui-sidebar__toggle"
        aria-label="Toggle menu"
        @click="emit('toggle-collapsed')"
      >
        <span aria-hidden="true">☰</span>
      </button>

      <div class="tui-sidebar__inner">
        <div
          v-for="{ group, items } in grouped"
          :key="group"
          class="tui-sidebar__group"
        >
          <div class="tui-sidebar__group-label">{{ labelFor(group) }}</div>
          <button
            v-for="tab in items"
            :key="tab.id"
            type="button"
            class="tui-sidebar__item"
            :class="{ 'tui-sidebar__item--active': tab.id === activeTab }"
            :aria-current="tab.id === activeTab ? 'page' : undefined"
            :data-tab-id="tab.id"
            @click="select(tab.id)"
            @keydown="onKey($event, tab.id)"
          >
            <span class="tui-sidebar__cursor">{{ tab.id === activeTab ? '▸' : ' ' }}</span>
            <span class="tui-sidebar__label">{{ tab.label }}</span>
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.tui-sidebar-root { display: contents; }

.tui-sidebar {
  width: 22ch;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 0.6rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-self: stretch;
  min-height: 100%;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.tui-sidebar--collapsed { width: 4ch; padding: 0.6rem 0; }

.tui-sidebar__toggle {
  display: none;
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  color: var(--fg-dim);
  font: inherit;
  cursor: pointer;
  padding: 0 1ch;
  text-align: left;
}

.tui-sidebar__inner {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.tui-sidebar--collapsed .tui-sidebar__inner { display: none; }

.tui-sidebar__group { display: flex; flex-direction: column; }

.tui-sidebar__group-label {
  padding: 0.4rem 1ch 0.2rem;
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dimmer);
}

.tui-sidebar__item {
  display: grid;
  grid-template-columns: 2ch 1fr;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  height: var(--row-h);
  padding: 0 1ch;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: color 0.08s;
}
.tui-sidebar__item:hover { background: var(--panel-hi); color: var(--fg); }
.tui-sidebar__item:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.tui-sidebar__item--active {
  background: var(--accent);
  color: var(--panel);
}
.tui-sidebar__item--active:hover { background: var(--accent); color: var(--panel); }

.tui-sidebar__cursor { color: inherit; font-weight: 700; }
.tui-sidebar__label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tui-sidebar__backdrop { display: none; }

@media (max-width: 768px) {
  .tui-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    width: 22ch;
    z-index: 100;
    transform: translateX(0);
    transition: transform 0.15s ease;
  }
  .tui-sidebar--collapsed { transform: translateX(-100%); }
  .tui-sidebar--collapsed .tui-sidebar__inner { display: flex; }
  .tui-sidebar__toggle { display: none; }
  .tui-sidebar__backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 90;
  }
}
</style>
