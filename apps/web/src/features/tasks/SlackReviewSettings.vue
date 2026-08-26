<script setup lang="ts">
import SlackReviewFields from '@/ui/SlackReviewFields.vue';
import type { Project, SlackMemberRef } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';

// Default del proyecto para "Solicitar review": a qué canal va y a quién taguea.
//
// Vive arriba del listado de tareas —y no en la tab del provider— porque es la
// config del botón que está en cada tarjeta de acá abajo: el operador que ve el
// botón apagado por falta de reviewers tiene el arreglo a la vista, sin cambiar
// de pantalla.
//
// Cada repo lo puede sobreescribir campo por campo (editor de repos); esto es
// lo que se usa cuando no lo hace.

const props = defineProps<{
  project: Project | null;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: 'save', settings: { slackReviewChannel: string | null; slackReviewers: SlackMemberRef[] | null }): void;
}>();

const open = ref(false);
const channel = ref('');
const reviewers = ref<SlackMemberRef[]>([]);

const originalChannel = computed(() => {
  const raw = props.project?.settings?.slackReviewChannel;
  return typeof raw === 'string' ? raw : '';
});

const originalReviewers = computed<SlackMemberRef[]>(() => {
  const raw = props.project?.settings?.slackReviewers;
  return Array.isArray(raw) ? (raw as SlackMemberRef[]) : [];
});

watch(
  () => props.project?.id,
  () => {
    channel.value = originalChannel.value;
    reviewers.value = [...originalReviewers.value];
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    channel.value !== originalChannel.value ||
    JSON.stringify(reviewers.value) !== JSON.stringify(originalReviewers.value),
);

/** Resumen para la fila colapsada: lo que hace falta saber sin abrir. */
const summary = computed(() => {
  if (!originalChannel.value) return 'sin canal configurado';
  const who = originalReviewers.value.length
    ? `${originalReviewers.value.length} reviewer(s)`
    : 'sin reviewers';
  return `${originalChannel.value} · ${who}`;
});

const incomplete = computed(() => !originalChannel.value || !originalReviewers.value.length);

function save() {
  emit('save', {
    // null (no '' ni []) para limpiar: el PATCH mergea settings por key.
    slackReviewChannel: channel.value.trim() || null,
    slackReviewers: reviewers.value.length ? reviewers.value : null,
  });
}
</script>

<template>
  <div class="srs">
    <button type="button" class="srs-head" :aria-expanded="open" @click="open = !open">
      <span class="srs-glyph">{{ open ? '▾' : '▸' }}</span>
      <span class="uc-label">Review en Slack</span>
      <span class="srs-summary" :class="{ 'is-incomplete': incomplete }">{{ summary }}</span>
    </button>

    <div v-if="open" class="srs-body">
      <p class="srs-desc">
        Default del proyecto para “Solicitar review”. Cada repo lo puede sobreescribir desde su
        propia configuración.
      </p>

      <SlackReviewFields
        v-model:channel="channel"
        v-model:reviewers="reviewers"
        inherit-label="nada — el pedido queda deshabilitado"
      />

      <div class="srs-actions">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="!dirty || saving || !project"
          @click="save"
        >{{ saving ? 'Guardando…' : 'Guardar' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.srs {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-alt);
  margin-bottom: 0.9rem;
}
.srs-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0 0.6rem;
  line-height: calc(var(--row-h) * 1.4);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--fg);
}
.srs-head:hover { background: var(--panel-hi); }
.srs-glyph { flex: 0 0 auto; color: var(--fg-dim); font-size: var(--fs-micro); }
.srs-summary {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.srs-summary.is-incomplete { color: var(--warn); }

.srs-body {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.6rem;
  border-top: 1px solid var(--border-mute);
}
.srs-desc { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.srs-field { display: flex; flex-direction: column; gap: 0.3rem; }
.srs-hint { color: var(--fg-dimmer); font-size: var(--fs-micro); }
.srs-actions { display: flex; justify-content: flex-end; }
</style>
