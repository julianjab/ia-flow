<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getScanRoots, setScanRoots } from '@/features/repos/api';
import { useToastStore } from '@/stores/toast';

// Directorios que ia-flow escanea al agregar un repo nuevo. Alimenta el
// autocomplete del campo `Path local` en el formulario de repo (por proyecto).
const toastStore = useToastStore();

const scanRoots = ref<string[]>([]);
const newScanRoot = ref('');
const saving = ref(false);

async function load() {
  try {
    scanRoots.value = await getScanRoots();
  } catch {
    /* non-fatal */
  }
}

async function add() {
  const root = newScanRoot.value.trim();
  if (!root || scanRoots.value.includes(root)) return;
  const updated = [...scanRoots.value, root];
  saving.value = true;
  try {
    await setScanRoots(updated);
    scanRoots.value = updated;
    newScanRoot.value = '';
    toastStore.success('Directorio de escaneo agregado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

async function remove(root: string) {
  const updated = scanRoots.value.filter((r) => r !== root);
  saving.value = true;
  try {
    await setScanRoots(updated);
    scanRoots.value = updated;
    toastStore.success('Directorio eliminado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="srs-section">
    <div>
      <h2>Directorios de escaneo</h2>
      <p class="srs-desc">
        Dónde buscar repos al agregar uno nuevo. ia-flow escanea cada directorio
        que agregues aquí y muestra sus subcarpetas como opciones en el campo
        <strong>Path local</strong> del formulario de repo (por proyecto).
        <br>Ejemplo: agregar <code>~/development/personal</code> expone todos los proyectos
        dentro de esa carpeta. <code>~/development/lahaus</code> siempre está incluido.
      </p>
    </div>

    <div class="srs-list">
      <div v-if="!scanRoots.length" class="srs-empty">
        Sin directorios adicionales configurados.
      </div>
      <div v-for="root in scanRoots" :key="root" class="srs-item">
        <span class="srs-path">{{ root }}</span>
        <button type="button" class="srs-remove" :disabled="saving" @click="remove(root)">✕</button>
      </div>
    </div>

    <div class="srs-add">
      <input
        v-model="newScanRoot"
        class="input srs-input"
        placeholder="~/development/personal"
        @keydown.enter.prevent="add"
      />
      <button type="button" class="srs-btn-add" :disabled="saving || !newScanRoot.trim()" @click="add">
        + Agregar
      </button>
    </div>
  </section>
</template>

<style scoped>
.srs-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.srs-section h2 { margin: 0 0 0.25rem; font-size: 1.05rem; }
.srs-desc { margin: 0; color: #6b7280; font-size: 0.85rem; line-height: 1.5; }

.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }

.srs-list { display: flex; flex-direction: column; gap: 0.35rem; }
.srs-empty { font-size: 0.85rem; color: #9ca3af; padding: 0.5rem 0; }
.srs-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.84rem;
}
.srs-path { flex: 1; font-family: 'SF Mono', 'Fira Code', monospace; color: #1e293b; font-size: 0.82rem; }
.srs-remove {
  padding: 0.15rem 0.45rem;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: #fff;
  color: #6b7280;
  font-size: 0.75rem;
  cursor: pointer;
  line-height: 1;
}
.srs-remove:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }
.srs-remove:disabled { opacity: 0.5; cursor: not-allowed; }

.srs-add { display: flex; gap: 0.5rem; align-items: center; }
.srs-input { flex: 1; }
.srs-btn-add {
  flex-shrink: 0;
  padding: 0.4rem 0.9rem;
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.srs-btn-add:hover { background: #000; }
.srs-btn-add:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
