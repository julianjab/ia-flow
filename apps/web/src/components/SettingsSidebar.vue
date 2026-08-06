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
  <aside
    class="settings-sidebar"
    :class="{ 'settings-sidebar--collapsed': collapsed }"
    role="navigation"
    aria-label="Settings sections"
  >
    <button
      type="button"
      class="settings-sidebar__toggle"
      aria-label="Toggle menu"
      @click="emit('toggle-collapsed')"
    >
      <span class="settings-sidebar__toggle-icon">☰</span>
    </button>

    <div class="settings-sidebar__inner">
      <div
        v-for="{ group, items } in grouped"
        :key="group"
        class="settings-sidebar__group"
      >
        <div class="settings-sidebar__group-label">{{ labelFor(group) }}</div>
        <button
          v-for="tab in items"
          :key="tab.id"
          type="button"
          class="settings-sidebar__item"
          :class="{ 'settings-sidebar__item--active': tab.id === activeTab }"
          :aria-current="tab.id === activeTab ? 'page' : undefined"
          :data-tab-id="tab.id"
          @click="select(tab.id)"
          @keydown="onKey($event, tab.id)"
        >
          <span class="settings-sidebar__icon" aria-hidden="true">{{ tab.icon }}</span>
          <span class="settings-sidebar__label">{{ tab.label }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.settings-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid #e5e7eb;
  background: #fafafa;
  padding: 1rem 0.65rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  align-self: stretch;
  min-height: 100%;
  box-sizing: border-box;
}

.settings-sidebar__toggle {
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  cursor: pointer;
  margin-bottom: 0.5rem;
}
.settings-sidebar__toggle:hover { background: #f3f4f6; }
.settings-sidebar__toggle-icon { font-size: 1rem; line-height: 1; }

.settings-sidebar__inner {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.settings-sidebar__group {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.settings-sidebar__group-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #9ca3af;
  font-weight: 600;
  padding: 0.15rem 0.65rem 0.35rem;
}

.settings-sidebar__item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: #374151;
  font-size: 0.86rem;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.settings-sidebar__item:hover {
  background: #f1f5f9;
  color: #1e293b;
}
.settings-sidebar__item:focus-visible {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
}
.settings-sidebar__item--active {
  background: #eff6ff;
  color: #1d4ed8;
  border-color: #bfdbfe;
}
.settings-sidebar__item--active:hover { background: #dbeafe; }

.settings-sidebar__icon {
  font-size: 1rem;
  line-height: 1;
  width: 1.25rem;
  text-align: center;
  flex-shrink: 0;
}

.settings-sidebar__label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
  .settings-sidebar {
    position: sticky;
    top: 0;
    width: 100%;
    border-right: none;
    border-bottom: 1px solid #e5e7eb;
    padding: 0.6rem 0.75rem;
    min-height: unset;
    z-index: 10;
  }
  .settings-sidebar__toggle {
    display: inline-flex;
    align-self: flex-start;
  }
  .settings-sidebar--collapsed .settings-sidebar__inner {
    display: none;
  }
}
</style>
