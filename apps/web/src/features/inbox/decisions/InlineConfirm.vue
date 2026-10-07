<script setup lang="ts">
// La confirmación en la misma card, en el lugar del botón: qué se firma, dónde y con quién, y
// «Cancelar» / «<Verbo> ahora». Ni `window.confirm` ni modal. `primary` sólo cuando reemplaza
// al primario de la pantalla («Lo primero»): hay uno solo. Si no, el que ejecuta es un `.btn`
// neutro: «Mergear ahora» ya lo distingue de «Cancelar». `danger` para lo riesgoso («Detener ahora»).

defineProps<{ text: string; label: string; primary?: boolean; danger?: boolean; busy?: boolean }>();
const emit = defineEmits<{ (e: 'cancel'): void; (e: 'confirm'): void }>();
</script>

<template>
  <div class="ic" role="group" aria-label="Confirmación" data-test="inline-confirm">
    <p class="ic__text">{{ text }}</p>
    <div class="ic__btns">
      <button type="button" class="btn" @click="emit('cancel')">Cancelar</button>
      <button
        type="button"
        class="btn"
        :class="{ 'btn--primary': primary, 'btn--danger': danger && !primary }"
        :disabled="busy"
        data-test="confirm"
        @click="emit('confirm')"
      >
        {{ label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ic {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 0.8rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--green-bg);
}
.ic__text { flex: 1 1 16rem; min-width: 0; margin: 0; color: var(--fg); font-size: var(--fs-body-sm); line-height: 1.45; overflow-wrap: anywhere; }
.ic__btns { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-left: auto; }
</style>
