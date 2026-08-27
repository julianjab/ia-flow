<script setup lang="ts">
import {
  type SlackChannelRef,
  lookupChannel,
  useSlackChannels,
} from '@/composables/useSlackDirectory';
import CopyButton from '@/ui/CopyButton.vue';
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

// El canal guardado es un id (`C0AG…`), que no dice nada. Antes el nombre sólo
// aparecía si ese id caía por casualidad en los resultados de la última
// búsqueda — o sea casi nunca, porque el desplegable no se carga hasta que
// alguien lo abre. Ahora se resuelve solo, apenas se conoce el valor.
const resolved = ref<SlackChannelRef | null>(null);

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

// Un solo watcher para resolver el nombre, sobre la prop y no sobre el
// computed: los dos cambian juntos, y duplicarlo dispararía dos lookups por
// cambio. `immediate` cubre el caso normal — el campo se monta con un valor ya
// guardado que nadie va a tocar.
//
// **Enfocado no resuelve.** Mientras se tipea, cada pulsación cambia el valor y
// dispararía un `GET /api/slack/channels` por tecla, todos contra ids a medio
// escribir que no matchean nada (y los misses no se cachean a propósito, para
// que el nombre aparezca solo cuando se arregle el token). Además el nombre ni
// se muestra con el campo enfocado. Al soltar el foco, el watcher corre una
// vez con el valor final.
watch(
  [() => props.modelValue, focused],
  ([v, isFocused]) => {
    if (!isFocused) void resolve(v);
  },
  { immediate: true },
);

async function resolve(v: string) {
  const key = v.trim().replace(/^#/, '');
  if (!key) {
    resolved.value = null;
    return;
  }
  if (resolved.value?.id === key || resolved.value?.name === key) return;
  const hit = await lookupChannel(key);
  // Contra una condición de carrera al tipear: la respuesta que llega tarde no
  // debe pisar al valor que el campo tiene AHORA.
  if (props.modelValue.trim().replace(/^#/, '') === key) resolved.value = hit ?? null;
}

function onFocus() {
  focused.value = true;
  if (!channels.value.length) void fetchNow(value.value.replace(/^#/, ''));
}

function pick(ch: SlackChannelRef) {
  // Se guarda el id y no el nombre: renombrar un canal en Slack no debería
  // romper el pedido de review.
  value.value = ch.id;
  // El nombre ya lo trae la opción elegida — no hace falta ir a buscarlo.
  resolved.value = ch;
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

/** El nombre del canal elegido, si el bot puede verlo. `undefined` cuando el
 *  id no existe, el bot no está en ese canal, o falta el token. */
const resolvedName = computed(() => resolved.value?.name);

/**
 * Lo que el campo MUESTRA, que no es lo que guarda.
 *
 * En reposo se lee `#reviews`, que es como el operador llama al canal; el id
 * (`C0AGHAKPG6T`) es un detalle de almacenamiento —se persiste el id para que
 * renombrar el canal en Slack no rompa el pedido de review— y sólo sale por el
 * botón de copiar, que es su único uso real: pegarlo en un `runner.yaml` o en
 * la API.
 *
 * Enfocado vuelve el valor crudo: es el que se está editando, y mostrar el
 * nombre mientras se tipea un id sería mentir sobre el contenido del input.
 * Sin nombre resuelto también se muestra el valor crudo — es la única verdad
 * disponible.
 */
const displayValue = computed(() =>
  !focused.value && resolvedName.value ? `#${resolvedName.value}` : value.value,
);
</script>

<template>
  <div class="scf">
    <input
      ref="inputRef"
      :value="displayValue"
      class="scf-input mono"
      :placeholder="placeholder ?? '#reviews o C0123ABCD'"
      :title="resolvedName ? `#${resolvedName} · ${value}` : value"
      @input="value = ($event.target as HTMLInputElement).value"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <CopyButton v-if="value.trim()" :value="value.trim()" label="el id del canal" />

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
