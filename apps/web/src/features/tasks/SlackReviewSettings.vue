<script setup lang="ts">
import SlackReviewFields from '@/ui/SlackReviewFields.vue';
import type { Project, SlackMemberRef, SlackReviewMessage } from '@ia-flow/shared';
import { SlackReviewMessageSchema, compactSlackReviewMessage } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';

// Default del proyecto para "Solicitar review": a qué canal va y a quién taguea.
//
// Vive arriba del listado de tareas —y no en la tab del provider— porque es la
// config del botón que está en cada tarjeta de acá abajo: el operador que ve el
// botón apagado por falta de reviewers tiene el arreglo a la vista, sin cambiar
// de pantalla.
//
// Es una cáscara fina sobre `SlackReviewFields` (que ya trae el colapsable y su
// resumen): acá sólo viven el borrador, el dirty y el guardado. Envolverlo en un
// segundo colapsable dejaba dos filas "Review en Slack" anidadas.

const props = defineProps<{
  project: Project | null;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (
    e: 'save',
    settings: {
      slackReviewChannel: string | null;
      slackReviewers: SlackMemberRef[] | null;
      slackReviewMessage: SlackReviewMessage | null;
    },
  ): void;
}>();

const channel = ref('');
const reviewers = ref<SlackMemberRef[]>([]);
const message = ref<SlackReviewMessage>({});

const originalChannel = computed(() => {
  const raw = props.project?.settings?.slackReviewChannel;
  return typeof raw === 'string' ? raw : '';
});

const originalReviewers = computed<SlackMemberRef[]>(() => {
  const raw = props.project?.settings?.slackReviewers;
  return Array.isArray(raw) ? (raw as SlackMemberRef[]) : [];
});

// El bag de settings es abierto: se parsea para no leer a ciegas de un
// `Record<string, unknown>`, igual que hace el use-case del server.
const originalMessage = computed<SlackReviewMessage>(
  () => SlackReviewMessageSchema.safeParse(props.project?.settings?.slackReviewMessage).data ?? {},
);

watch(
  () => props.project?.id,
  () => {
    channel.value = originalChannel.value;
    reviewers.value = [...originalReviewers.value];
    message.value = { ...originalMessage.value };
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    channel.value !== originalChannel.value ||
    JSON.stringify(reviewers.value) !== JSON.stringify(originalReviewers.value) ||
    JSON.stringify(compactSlackReviewMessage(message.value) ?? {}) !==
      JSON.stringify(compactSlackReviewMessage(originalMessage.value) ?? {}),
);

function save() {
  emit('save', {
    // null (no '' ni []) para limpiar: el PATCH mergea settings por key.
    slackReviewChannel: channel.value.trim() || null,
    slackReviewers: reviewers.value.length ? reviewers.value : null,
    slackReviewMessage: compactSlackReviewMessage(message.value) ?? null,
  });
}
</script>

<template>
  <SlackReviewFields
    v-model:channel="channel"
    v-model:reviewers="reviewers"
    v-model:message="message"
    class="srs"
    inherit-label="nada — el pedido queda deshabilitado"
    description="Default del proyecto para “Solicitar review”. Cada repo lo puede sobreescribir desde su propia configuración."
  >
    <template #actions>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="!dirty || saving || !project"
        @click="save"
      >{{ saving ? 'Guardando…' : 'Guardar' }}</button>
    </template>
  </SlackReviewFields>
</template>

<style scoped>
.srs { margin-bottom: 0.9rem; }
</style>
