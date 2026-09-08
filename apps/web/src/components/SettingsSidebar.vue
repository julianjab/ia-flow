<script setup lang="ts" generic="TabId extends string">
import { computed } from 'vue';

export interface SidebarChild {
  id: string;
  label: string;
  path: string;
  /** Sub-children shown only when this child (or one of its descendants) is
   *  the active URL. Enables the 3-level tree used by Proyectos. */
  children?: SidebarChild[];
}

interface TabItem {
  id: TabId;
  label: string;
  icon: string;
  group: string;
  children?: SidebarChild[];
}

const props = defineProps<{
  tabs: TabItem[];
  activeTab: TabId;
  /** Full router path — enables highlighting a nested child row. */
  activePath?: string;
  groupLabels?: Record<string, string>;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:activeTab', tab: TabId): void;
  /** `hasChildren` — el nodo clickeado todavía revela otro nivel (ej. un
   *  proyecto con sus tabs). El consumidor lo usa para no colapsar el
   *  sidebar en mobile: colapsar ahí ocultaría el árbol justo cuando el
   *  usuario quiere seguir bajando un nivel más. */
  (e: 'navigate', path: string, hasChildren: boolean): void;
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

function navigateChild(child: SidebarChild) {
  emit('navigate', child.path, !!child.children?.length);
}

function isChildActive(child: SidebarChild): boolean {
  if (!props.activePath) return false;
  // A child is active when the URL matches its path exactly, shares its
  // segment root (e.g. /general/agentes matches /general/agentes/foo), OR
  // when any of its descendants is active. The descendant check keeps a
  // parent expanded while the user browses its sibling leaves (Proyectos →
  // project → tab): without it, clicking a leaf whose path diverges from
  // the parent's default (e.g. /projects/:id/ejecuciones when the parent's
  // path is /projects/:id/overview) would collapse the whole subtree.
  if (props.activePath === child.path || props.activePath.startsWith(`${child.path}/`)) return true;
  return child.children?.some((c) => isChildActive(c)) ?? false;
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
      <div class="tui-sidebar__inner">
        <div
          v-for="{ group, items } in grouped"
          :key="group"
          class="tui-sidebar__group"
        >
          <div class="tui-sidebar__group-label">{{ labelFor(group) }}</div>

          <template v-for="tab in items" :key="tab.id">
            <button
              type="button"
              class="tui-sidebar__item"
              :class="{ 'tui-sidebar__item--active': tab.id === activeTab }"
              :aria-current="tab.id === activeTab ? 'page' : undefined"
              :data-tab-id="tab.id"
              @click="select(tab.id)"
              @keydown="onKey($event, tab.id)"
            >
              <span class="tui-sidebar__cursor">
                <template v-if="tab.children?.length">
                  {{ tab.id === activeTab ? '▾' : '▸' }}
                </template>
                <template v-else>{{ tab.id === activeTab ? '▸' : ' ' }}</template>
              </span>
              <span class="tui-sidebar__label">{{ tab.label }}</span>
            </button>

            <!-- Nested children — visible only when the parent section is
                 active. Each child can itself expand a third level when
                 the URL sits below it (used by Proyectos → project → tab). -->
            <div
              v-if="tab.children?.length && tab.id === activeTab"
              class="tui-sidebar__children"
            >
              <template v-for="child in tab.children" :key="child.id">
                <button
                  type="button"
                  class="tui-sidebar__child"
                  :class="{ 'tui-sidebar__child--active': isChildActive(child) }"
                  :data-child-id="child.id"
                  @click="navigateChild(child)"
                >
                  <span class="tui-sidebar__child-cursor">
                    {{ isChildActive(child) ? (child.children?.length ? '▾' : '▸') : ' ' }}
                  </span>
                  <span class="tui-sidebar__label">{{ child.label }}</span>
                </button>

                <div
                  v-if="child.children?.length && isChildActive(child)"
                  class="tui-sidebar__children tui-sidebar__children--l2"
                >
                  <button
                    v-for="leaf in child.children"
                    :key="leaf.id"
                    type="button"
                    class="tui-sidebar__child tui-sidebar__child--leaf"
                    :class="{ 'tui-sidebar__child--active': isChildActive(leaf) }"
                    :data-child-id="leaf.id"
                    @click="navigateChild(leaf)"
                  >
                    <span class="tui-sidebar__child-cursor">
                      {{ isChildActive(leaf) ? '▸' : ' ' }}
                    </span>
                    <span class="tui-sidebar__label">{{ leaf.label }}</span>
                  </button>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.tui-sidebar-root { display: contents; }

.tui-sidebar {
  width: 26ch;
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
.tui-sidebar--collapsed { width: 0; padding: 0; overflow: hidden; border-right: none; }

.tui-sidebar__inner {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.tui-sidebar__group { display: flex; flex-direction: column; }

.tui-sidebar__group-label {
  padding: 0.4rem 1ch 0.25rem;
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
  color: var(--fg-mute);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.tui-sidebar__item:hover { background: var(--panel-hi); color: var(--fg); }
.tui-sidebar__item:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.tui-sidebar__item--active {
  background: var(--accent);
  color: var(--panel);
  font-weight: 700;
}
.tui-sidebar__item--active:hover { background: var(--accent); color: var(--panel); }

.tui-sidebar__cursor { color: inherit; font-weight: 700; text-align: center; }
.tui-sidebar__label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Nested children — indented one column and visually attached to the parent
   via a hairline rail. */
.tui-sidebar__children {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  margin-left: calc(1ch + 1ch);
  padding-left: 0;
}
.tui-sidebar__child {
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
  font-size: var(--fs-body-sm);
  cursor: pointer;
  text-align: left;
}
.tui-sidebar__child:hover { background: var(--panel-hi); color: var(--fg); }
.tui-sidebar__child--active {
  background: transparent;
  color: var(--accent);
  font-weight: 700;
}
.tui-sidebar__child--active:hover { color: var(--accent); }
.tui-sidebar__child-cursor { color: inherit; text-align: center; }

/* Second nesting level (project → tab). Indents one more column with its
   own hairline rail so the hierarchy stays legible even inside a project. */
.tui-sidebar__children--l2 {
  margin-left: 2ch;
  border-left: 1px solid var(--border);
}
.tui-sidebar__child--leaf {
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.tui-sidebar__child--leaf.tui-sidebar__child--active { color: var(--accent); }

.tui-sidebar__backdrop { display: none; }

@media (max-width: 768px) {
  .tui-sidebar {
    position: fixed;
    /* Arranca DEBAJO del header, no en 0. Con `top: 0` y `z-index: 100` el
       panel abierto tapaba la barra entera — incluido el ☰ que lo cierra, así
       que la única salida era el backdrop. Y sus primeros ítems quedaban bajo
       el header, invisibles. */
    top: var(--chrome-h);
    left: 0;
    height: calc(100vh - var(--chrome-h));
    width: 26ch;
    z-index: 100;
    transform: translateX(0);
    transition: transform 0.15s ease;
  }
  .tui-sidebar--collapsed { transform: translateX(-100%); width: 26ch; }
  .tui-sidebar__backdrop {
    display: block;
    position: fixed;
    /* Igual que el panel: el header queda usable con el menú abierto. */
    inset: var(--chrome-h) 0 0 0;
    background: rgba(0,0,0,0.6);
    z-index: 90;
  }
}
</style>
