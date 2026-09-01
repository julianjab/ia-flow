<script setup lang="ts">
import { useSlackMembers } from '@/composables/useSlackDirectory';
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';
import CopyButton from '@/ui/CopyButton.vue';
import type { SlackMemberRef } from '@ia-flow/shared';
import { computed, ref } from 'vue';

// Los reviewers de Slack, sobre el ComboBox del design system. Lo único propio
// de este campo es el dominio: traducir `SlackMemberRef` ↔ id y pedirle al
// server que busque. El teclado, los chips y el desplegable son los mismos que
// en cualquier otro campo de selección de la app.
//
// NO acepta valores ad-hoc (`allowCustom` queda en false): una mención se arma
// con el id (`<@U123>`), así que un nombre escrito a mano no taguearía a nadie
// — se vería bien en la UI y fallaría en silencio en el mensaje.

const props = defineProps<{
  modelValue: SlackMemberRef[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: SlackMemberRef[]): void;
}>();

const { members, loading, failed, search, fetchNow } = useSlackMembers();

const selected = computed(() => props.modelValue ?? []);
const ids = computed(() => selected.value.map((m) => m.id));

const label = (m: SlackMemberRef) => m.name || m.id;

// El ref de cada miembro elegido viaja en `options` aunque ya no esté en el
// resultado de la última búsqueda: el ComboBox saca la etiqueta del chip de
// ahí, y sin esto buscar otra cosa dejaba a los chips existentes mostrando el
// id crudo.
const options = computed<ComboOption[]>(() => {
  const byId = new Map<string, SlackMemberRef>();
  for (const m of selected.value) byId.set(m.id, m);
  for (const m of members.value) byId.set(m.id, m);
  return [...byId.values()].map((m) => ({
    value: m.id,
    label: label(m),
    // El id va en TODAS las opciones. Un bot que mostraba sólo la palabra
    // "bot" es justo el caso donde el nombre menos identifica.
    hint: m.isBot ? `bot · ${m.id}` : m.id,
    glyph: m.isBot ? '✦' : '●',
    title: `${label(m)} (${m.id})`,
  }));
});

// Lo que se conoce de cada id, para reconstruir el ref al emitir. Es un ref y
// no un computed porque tiene que acordarse de un miembro elegido hace tres
// búsquedas, que ya no está en `members`.
const known = ref(new Map<string, SlackMemberRef>(selected.value.map((m) => [m.id, m])));

function onUpdate(next: string | string[]) {
  const list = Array.isArray(next) ? next : [next];
  for (const m of members.value) known.value.set(m.id, m);
  emit(
    'update:modelValue',
    list.map((id) => known.value.get(id) ?? { id }),
  );
}

// Primera apertura: el listado inicial es el que hace que el picker no arranque
// vacío sin que el usuario adivine qué escribir.
function onSearch(q: string) {
  if (!members.value.length) void fetchNow(q);
  else search(q);
}
</script>

<template>
  <ComboBox
    multiple
    remote
    :model-value="ids"
    :options="options"
    :loading="loading"
    :error="
      failed
        ? 'No se pudo leer el directorio de Slack — revisa SLACK_BOT_TOKEN y el scope users:read.'
        : ''
    "
    :placeholder="placeholder ?? 'Buscar persona o bot…'"
    @update:model-value="onUpdate"
    @search="onSearch"
  >
    <!-- El chip muestra el NOMBRE, que es lo que el operador reconoce; el id
         sale por el botón de copiar, que es su único uso real (pegarlo en un
         runner.yaml o en la API). -->
    <template #chip-extra="{ value }">
      <CopyButton :value="value" :label="`el id de ${value}`" />
    </template>
  </ComboBox>
</template>
