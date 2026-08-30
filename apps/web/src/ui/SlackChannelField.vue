<script setup lang="ts">
import {
  type SlackChannelRef,
  lookupChannel,
  useSlackChannels,
} from '@/composables/useSlackDirectory';
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';
import CopyButton from '@/ui/CopyButton.vue';
import { computed, ref, watch } from 'vue';

// Un canal, sobre el ComboBox del design system.
//
// Acepta texto libre a propósito (a diferencia del picker de reviewers): la
// lista es lo que el BOT ve, no el workspace — Slack sólo devuelve los canales
// donde la app está instalada, y los privados sólo si es miembro. Un canal que
// no aparece se pega por id y funciona igual.
//
// Se guarda el id y no el nombre: renombrar un canal en Slack no debería romper
// el pedido de review. Lo que se LEE es `#nombre`, que es como el operador lo
// llama; el id sale por el botón de copiar, su único uso real (pegarlo en un
// `runner.yaml` o en la API).

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { channels, loading, failed, warnings, search, fetchNow } = useSlackChannels();

// El canal guardado es un id (`C0AG…`), que no dice nada. Se resuelve solo,
// apenas se conoce el valor: esperar a que alguien abra el desplegable dejaba
// el campo mostrando un id opaco en el estado en que más se lo mira.
//
// Antes esto necesitaba un guard contra el foco, porque el campo emitía cada
// tecla y eso era un GET por pulsación contra ids a medio escribir. Ya no: el
// ComboBox se queda con lo que se tipea y sólo emite al confirmar, así que el
// watcher corre una vez por valor de verdad.
const resolved = ref<SlackChannelRef | null>(null);

watch(
  () => props.modelValue,
  (v) => void resolve(v),
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
  // Contra una condición de carrera: la respuesta que llega tarde no debe pisar
  // al valor que el campo tiene AHORA.
  if (props.modelValue.trim().replace(/^#/, '') === key) resolved.value = hit ?? null;
}

const options = computed<ComboOption[]>(() => {
  const byId = new Map<string, SlackChannelRef>();
  // El canal elegido va primero y siempre: el ComboBox saca de acá la etiqueta
  // del chip, y sin él un id guardado se vería crudo hasta la primera búsqueda.
  if (resolved.value) byId.set(resolved.value.id, resolved.value);
  for (const c of channels.value) byId.set(c.id, c);
  return [...byId.values()].map((c) => ({
    value: c.id,
    label: `#${c.name}`,
    hint: c.isPrivate ? 'privado' : c.id,
    glyph: c.isPrivate ? '◆' : '#',
    title: `#${c.name} · ${c.id}`,
  }));
});

const foot = computed(() =>
  failed.value
    ? 'No se pudo leer los canales de Slack — revisa SLACK_BOT_TOKEN y el scope channels:read.'
    : '',
);

function onSearch(q: string) {
  const key = q.replace(/^#/, '');
  if (!channels.value.length) void fetchNow(key);
  else search(key);
}
</script>

<template>
  <div class="scf">
    <ComboBox
      allow-custom
      remote
      :model-value="modelValue"
      :options="options"
      :loading="loading"
      :error="foot"
      :placeholder="placeholder ?? '#reviews o C0123ABCD'"
      @update:model-value="(v) => emit('update:modelValue', Array.isArray(v) ? (v[0] ?? '') : v)"
      @search="onSearch"
    >
      <template #chip-extra="{ value }">
        <CopyButton :value="value" label="el id del canal" />
      </template>
    </ComboBox>
    <!-- Fuera del desplegable y no adentro: es la explicación de por qué falta
         un canal, y hace falta justo cuando el que falta no está en la lista
         que se está mirando. -->
    <p class="scf-foot">
      Sólo aparecen los canales visibles para el bot{{
        warnings.length ? ` (${warnings.join('; ')})` : ''
      }}. Si falta uno, invitá al bot al canal o pegá su id (C0123ABCD).
    </p>
  </div>
</template>

<style scoped>
.scf {
  min-width: 0;
}
.scf-foot {
  margin: 0.2rem 0 0;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  line-height: 1.4;
}
</style>
