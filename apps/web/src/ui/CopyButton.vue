<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

// Botón de copiar un valor literal (un id de Slack, un node id, una branch).
//
// Existe como primitiva porque el valor que la consola muestra en mono es,
// por definición del design system, "lo que el usuario podría copiar y pegar"
// — y seleccionarlo con el mouse dentro de un chip pelea con el click del
// chip. Acá el gesto es explícito y no compite con nada.
//
// El feedback es local y no un toast: `ui/` no conoce el estado de la app, y
// un toast global para confirmar un copiado es más ruido que señal.

const props = defineProps<{
  value: string;
  /** Qué se copia, para el `aria-label` y el tooltip. */
  label?: string;
}>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    // Ausente fuera de un contexto seguro (http:// que no sea localhost). Se
    // ignora en silencio: el botón simplemente no confirma, en vez de romper
    // el formulario que lo contiene.
    await navigator.clipboard?.writeText(props.value);
    copied.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    /* sin portapapeles no hay nada que confirmar */
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <button
    type="button"
    class="copy-btn"
    :class="{ 'is-copied': copied }"
    :aria-label="copied ? 'Copiado' : `Copiar ${label ?? value}`"
    :title="copied ? 'Copiado' : `Copiar ${label ?? value}`"
    @click.stop="copy"
  >{{ copied ? '✓' : '⧉' }}</button>
</template>

<style scoped>
.copy-btn {
  flex: 0 0 auto;
  background: none;
  border: none;
  padding: 0 0.15rem;
  cursor: pointer;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1;
}
.copy-btn:hover { color: var(--fg); }
.copy-btn.is-copied { color: var(--accent); }
</style>
