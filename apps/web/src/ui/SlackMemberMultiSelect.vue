<script setup lang="ts">
import { useSlackMembers } from '@/composables/useSlackDirectory';
import CopyButton from '@/ui/CopyButton.vue';
import type { SlackMemberRef } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';

// Picker de miembros de Slack con chips: buscar, agregar varios, quitar.
//
// A diferencia de RepoMultiSelect NO acepta valores ad-hoc: una mención se arma
// con el id (`<@U123>`), así que un nombre escrito a mano no taguearía a nadie —
// se vería bien en la UI y fallaría silenciosamente en el mensaje.
//
// Bots incluidos y marcados: taguear al bot revisor es medio caso de uso.

const props = defineProps<{
  modelValue: SlackMemberRef[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: SlackMemberRef[]): void;
}>();

const { members, loading, failed, search, fetchNow } = useSlackMembers();

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const focused = ref(false);
const activeIndex = ref(-1);

const selected = computed(() => props.modelValue ?? []);

const suggestions = computed(() => {
  const already = new Set(selected.value.map((m) => m.id));
  return members.value.filter((m) => !already.has(m.id)).slice(0, 20);
});

watch(query, (q) => {
  activeIndex.value = -1;
  search(q);
});

function onFocus() {
  focused.value = true;
  // Primera apertura: el listado inicial es el que hace que el picker no
  // arranque vacío sin que el usuario adivine qué escribir.
  if (!members.value.length) void fetchNow(query.value);
}

function addChip(member: SlackMemberRef) {
  if (selected.value.some((m) => m.id === member.id)) return;
  emit('update:modelValue', [...selected.value, member]);
  query.value = '';
  activeIndex.value = -1;
}

function removeChip(id: string) {
  emit(
    'update:modelValue',
    selected.value.filter((m) => m.id !== id),
  );
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const pick = suggestions.value[activeIndex.value >= 0 ? activeIndex.value : 0];
    if (pick) addChip(pick);
  } else if (e.key === 'Backspace' && !query.value && selected.value.length) {
    removeChip(selected.value[selected.value.length - 1].id);
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
  // Con delay para que un click en una sugerencia alcance a dispararse.
  setTimeout(() => {
    focused.value = false;
  }, 120);
}

// El chip muestra el NOMBRE, que es lo que el operador reconoce. El id no se
// imprime al lado: alarga cada chip con ruido que no se lee, y el único uso
// real que tiene —pegarlo en un `runner.yaml` o en un `slackReviewers` de la
// API— lo cubre el botón de copiar. Sigue en el `title` para quien lo quiera
// leer sin copiarlo.
function label(m: SlackMemberRef): string {
  return m.name || m.id;
}
</script>

<template>
  <div class="sms" :class="{ 'sms--focused': focused }" @click="inputRef?.focus()">
    <span
      v-for="m in selected"
      :key="m.id"
      class="tag sms-chip"
      :class="{ 'sms-chip--bot': m.isBot }"
      :title="`${label(m)} (${m.id})`"
    >
      <span class="tag__glyph">{{ m.isBot ? '✦' : '●' }}</span>
      <span class="tag__text">{{ label(m) }}</span>
      <CopyButton :value="m.id" :label="`el id de ${label(m)}`" />
      <button
        type="button"
        class="sms-chip__remove"
        :aria-label="`Quitar ${label(m)}`"
        @click.stop="removeChip(m.id)"
      >✕</button>
    </span>

    <input
      ref="inputRef"
      v-model="query"
      class="sms-input"
      :placeholder="selected.length ? '' : (placeholder ?? 'Buscar persona o bot…')"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />

    <ul v-if="focused" class="sms-dropdown">
      <li v-if="loading" class="sms-option sms-option--note">Buscando…</li>
      <li v-else-if="failed" class="sms-option sms-option--note">
        No se pudo leer el directorio de Slack — revisa SLACK_BOT_TOKEN y el scope users:read.
      </li>
      <li v-else-if="!suggestions.length" class="sms-option sms-option--note">Sin resultados</li>
      <li
        v-for="(m, i) in suggestions"
        :key="m.id"
        :class="['sms-option', { 'sms-option--active': i === activeIndex }]"
        @mousedown.prevent="addChip(m)"
        @mouseenter="activeIndex = i"
      >
        <span class="sms-option__name">{{ label(m) }}</span>
        <!-- El id va en TODAS las opciones. Antes un bot mostraba sólo la
             palabra "bot", que es justo el caso donde el nombre menos
             identifica: el glifo del chip ya distingue bot de persona. -->
        <span class="sms-option__hint">{{ m.isBot ? `bot · ${m.id}` : m.id }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sms {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.35rem;
  min-height: calc(var(--row-h) + 0.4rem);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  cursor: text;
}
.sms--focused { border-color: var(--border-hi); }

/* Misma caja que el resto de los chips de la consola (ver TaskTags): lo que
   varía por tipo es el color del glifo, no la caja. */
.tag {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  max-width: min(28ch, 100%);
  min-width: 0;
  padding: 0 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  white-space: nowrap;
}
.tag__text {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  /* El chip está dentro de un contenedor con `cursor: text` que enfoca el
     input al click; sin esto el texto tampoco se puede seleccionar a mano. */
  user-select: text;
}
.tag__glyph { flex: 0 0 auto; font-size: 0.9em; color: var(--info); }
.sms-chip--bot .tag__glyph { color: var(--ai); }

.sms-chip__remove {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-micro);
  line-height: 1;
  padding: 0 0.1rem;
}
.sms-chip__remove:hover { color: var(--danger); }

.sms-input {
  flex: 1;
  min-width: 10ch;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--fs-body-sm);
  padding: 0;
  line-height: var(--row-h);
}

.sms-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  list-style: none;
  margin: 0;
  padding: 0.2rem 0;
  z-index: 20;
  max-height: calc(var(--row-h) * 10);
  overflow-y: auto;
}
.sms-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.5rem;
  line-height: var(--row-h);
  cursor: pointer;
  font-size: var(--fs-body-sm);
}
.sms-option--active { background: var(--accent); color: var(--panel); }
.sms-option--active .sms-option__name,
.sms-option--active .sms-option__hint { color: inherit; }
.sms-option__name { color: var(--fg); }
.sms-option__hint {
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.sms-option--note {
  cursor: default;
  color: var(--fg-dimmer);
  white-space: normal;
  line-height: 1.4;
  padding: 0.3rem 0.5rem;
}
</style>
