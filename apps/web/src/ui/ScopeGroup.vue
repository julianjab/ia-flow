<script setup lang="ts">
// El encabezado de un grupo por ámbito: lo PROPIO arriba, lo HEREDADO abajo.
//
// Cinco pantallas configuran lo mismo en dos niveles (agentes, pipeline,
// acciones, tools y system prompts) y las cinco tienen que contestar la misma
// pregunta antes que cualquier otra: **¿esto lo puedo tocar acá?**. Cuando cada
// sección escribía su propio `<h3>`, tres de ellas ni siquiera mostraban lo
// heredado —y el pipeline de un proyecto se veía vacío mientras cinco reglas
// globales trabajaban sobre sus issues.
//
// El grupo heredado no es un aviso de error: es configuración que SÍ está
// corriendo. Por eso se lista completa y clickeable —el detalle se abre igual,
// en modo lectura— y lo único que dice el encabezado es dónde se edita.

withDefaults(
  defineProps<{
    /** `own` = de este ámbito, editable. `inherited` = viene de arriba. */
    variant: 'own' | 'inherited'
    count: number
    /** Título. Sin esto, el que corresponde a la variante. */
    label?: string
    /** Dónde SÍ se edita lo heredado, en palabras de la UI ("General → Tools").
     *  Sólo se muestra en `inherited`: es la salida del callejón. */
    editHint?: string
  }>(),
  {},
)
</script>

<template>
  <div class="scope-group" :class="`scope-group--${variant}`">
    <h3 class="scope-group__title">
      {{ label ?? (variant === 'own' ? 'De este ámbito' : 'Heredadas del ámbito global') }}
      <span class="scope-group__count">{{ count }}</span>
      <span v-if="variant === 'inherited'" class="scope-group__badge">solo lectura aquí</span>
    </h3>
    <p v-if="variant === 'inherited' && editHint" class="scope-group__hint">
      Se aplican a este proyecto pero se editan en <b>{{ editHint }}</b>.
    </p>
    <div class="scope-group__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.scope-group { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.9rem; }

.scope-group__title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* Envuelve en vez de desbordar: en un celular el badge al lado de un título
     largo empuja la página. */
  flex-wrap: wrap;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-mute);
  font-weight: 600;
}

.scope-group__count { color: var(--fg-dim); font-weight: 400; }

.scope-group__badge {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 0.5ch;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  letter-spacing: 0;
  text-transform: none;
  font-weight: 400;
}

.scope-group__hint {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
}

.scope-group__body { display: flex; flex-direction: column; gap: 0.3rem; }
</style>
