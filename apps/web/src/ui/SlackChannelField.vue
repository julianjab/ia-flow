<script setup lang="ts">
import { type SlackChannelRef, useSlackChannels } from '@/composables/useSlackDirectory';
import { computed, ref, watch } from 'vue';

// Un canal, con autocomplete. Acepta texto libre a propósito (a diferencia del
// picker de reviewers): un canal se puede nombrar por id (`C0123…`) o por
// `#nombre`, y el bot puede tener que postear en uno que `conversations.list`
// no devuelve — un canal privado donde todavía no fue invitado.

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { channels, loading, failed, warnings, search, fetchNow } = useSlackChannels();

const focused = ref(false);
const activeIndex = ref(-1);
const inputRef = ref<HTMLInputElement | null>(null);

const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});

watch(value, (v) => {
  activeIndex.value = -1;
  if (focused.value) search(v.replace(/^#/, ''));
});

function onFocus() {
  focused.value = true;
  if (!channels.value.length) void fetchNow(value.value.replace(/^#/, ''));
}

function pick(ch: SlackChannelRef) {
  // Se guarda el id y no el nombre: renombrar un canal en Slack no debería
  // romper el pedido de review.
  value.value = ch.id;
  activeIndex.value = -1;
  inputRef.value?.blur();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, channels.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, -1);
  } else if (e.key === 'Enter' && activeIndex.value >= 0) {
    e.preventDefault();
    pick(channels.value[activeIndex.value]);
  } else if (e.key === 'Escape') {
    inputRef.value?.blur();
  }
}

function onBlur() {
  setTimeout(() => {
    focused.value = false;
  }, 120);
}

/** El canal ya elegido, resuelto a nombre si el directorio lo conoce. */
const resolvedName = computed(
  () => channels.value.find((c) => c.id === value.value)?.name,
);
</script>

<template>
  <div class="scf">
    <input
      ref="inputRef"
      v-model="value"
      class="scf-input mono"
      :placeholder="placeholder ?? '#reviews o C0123ABCD'"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <span v-if="resolvedName && !focused" class="scf-resolved">#{{ resolvedName }}</span>

    <ul v-if="focused" class="scf-dropdown">
      <li v-if="loading" class="scf-option scf-option--note">Buscando…</li>
      <li v-else-if="failed" class="scf-option scf-option--note">
        No se pudo leer los canales de Slack — revisa SLACK_BOT_TOKEN y el scope channels:read.
      </li>
      <li v-else-if="!channels.length" class="scf-option scf-option--note">Sin resultados</li>
      <li
        v-for="(ch, i) in channels"
        :key="ch.id"
        :class="['scf-option', { 'scf-option--active': i === activeIndex }]"
        @mousedown.prevent="pick(ch)"
        @mouseenter="activeIndex = i"
      >
        <span class="scf-option__name">#{{ ch.name }}</span>
        <span class="scf-option__hint">{{ ch.isPrivate ? 'privado' : ch.id }}</span>
      </li>
      <!-- La lista es lo que el BOT ve, no el workspace entero: Slack sólo
           devuelve los canales a los que la app está instalada, y los privados
           sólo si es miembro. Por eso el campo acepta texto libre: un canal que
           no está acá se pega por id y funciona igual. -->
      <li v-if="!loading && !failed" class="scf-option scf-option--note scf-option--foot">
        Sólo aparecen los canales visibles para el bot{{ warnings.length ? ` (${warnings.join('; ')})` : '' }}.
        Si falta uno, invitá al bot al canal o pegá su id (C0123ABCD).
      </li>
    </ul>
  </div>
</template>

<style scoped>
.scf { position: relative; display: flex; align-items: center; gap: 0.4rem; }
.scf-input {
  flex: 1;
  min-width: 0;
  line-height: var(--row-h);
}
.scf-resolved {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--info);
}
.scf-dropdown {
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
.scf-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.5rem;
  line-height: var(--row-h);
  cursor: pointer;
  font-size: var(--fs-body-sm);
}
.scf-option--active { background: var(--accent); color: var(--panel); }
.scf-option--active .scf-option__name,
.scf-option--active .scf-option__hint { color: inherit; }
.scf-option__name { color: var(--fg); font-family: var(--font-mono); }
.scf-option__hint {
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.scf-option--foot { border-top: 1px solid var(--border-mute); margin-top: 0.2rem; }
.scf-option--note {
  cursor: default;
  color: var(--fg-dimmer);
  white-space: normal;
  line-height: 1.4;
  padding: 0.3rem 0.5rem;
}
</style>
