<script setup lang="ts">
import FullScreen from '@/ui/FullScreen.vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import type { SourceRef } from '@ia-flow/shared';
import axios from 'axios';
import { computed, ref, watch } from 'vue';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import SourceFormSwitch from '@/features/projects/sources/SourceFormSwitch.vue';
import DaemonModeField from '@/features/projects/DaemonModeField.vue';

// Extracts the server-side { error } payload when present. Falls back to
// the axios/Error message so we never render an empty box.
function extractError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { error?: string; message?: string } | undefined;
    if (data?.error) return data.error;
    if (data?.message) return data.message;
    return e.message;
  }
  return extractErrorMessage(e);
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'created', id: string): void }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const name = ref('');
const id = ref('');
const source = ref<SourceRef | null>({ kind: 'local', config: {} });
// null = heredar (env / default del server); ver DaemonModeField.
const daemonMode = ref<string | null>(null);
const idDirty = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

// Derive a slug from the name until the user edits the id manually.
function nameToSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

watch(name, (n) => {
  if (!idDirty.value) id.value = nameToSlug(n);
});

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      name.value = '';
      id.value = '';
      source.value = { kind: 'local', config: {} };
      daemonMode.value = null;
      idDirty.value = false;
      error.value = null;
    }
  },
);

const canSave = computed(() => name.value.trim() !== '' && id.value.trim() !== '');

async function submit() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = null;
  try {
    const project = await projectsStore.create({
      id: id.value.trim(),
      name: name.value.trim(),
      source: source.value ?? undefined,
      settings: daemonMode.value ? { daemonMode: daemonMode.value } : undefined,
    });
    toastStore.success(`Proyecto '${project.name}' creado`);
    emit('created', project.id);
    emit('close');
  } catch (e) {
    error.value = extractError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <!-- Bajo --bp-shell es una pantalla con `←` (A3): un diálogo con un selector
       de source adentro no cabe en 390px, y su `Crear` quedaba a varias
       pantallas de scroll DENTRO de una caja que ya no se veía entera. -->
  <FullScreen :open="open" title="Nuevo proyecto" @close="emit('close')">
    <label class="ff-row">
      <span class="uc-label">Nombre *</span>
      <input v-model="name" class="ff-field" placeholder="Mi proyecto" autofocus />
    </label>

    <label class="ff-row">
      <span class="uc-label">ID (slug) *</span>
      <input
        v-model="id"
        class="ff-field ff-mono"
        placeholder="mi-proyecto"
        @input="idDirty = true"
      />
      <span class="ff-hint">Identificador único, sin espacios (a-z, 0-9, -)</span>
    </label>

    <div class="ff-row">
      <SourceFormSwitch v-model="source" />
      <span class="ff-hint">
        El proveedor que gestiona los items del proyecto. Puedes cambiarlo después.
      </span>
    </div>

    <div class="ff-row">
      <DaemonModeField v-model="daemonMode" />
    </div>

    <p v-if="error" class="ff-error">{{ error }}</p>

    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">
        Cancelar
      </button>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="!canSave || saving"
        @click="submit"
      >
        {{ saving ? 'Creando…' : 'Crear proyecto' }}
      </button>
    </template>
  </FullScreen>
</template>

<style scoped src="@/ui/form-fields.css"></style>
