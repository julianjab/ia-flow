<script setup lang="ts">
// Un interruptor de dos estados, con la caja del sistema.
//
// ── Por qué una primitiva y no un botón por pantalla ────────────────────
//
// "Esto está prendido o apagado" es una pregunta que aparece en varias
// pantallas (una regla en un proyecto, un agente, un provider), y hasta ahora
// cada una la contestaba con su propio botón de texto. Un botón que dice
// "Desactivar" obliga a leerlo para saber el estado ACTUAL —y a leerlo al revés,
// porque el texto nombra la acción, no el estado—, así que una lista de veinte
// filas se recorre leyendo veinte verbos en vez de mirando veinte luces.
//
// El interruptor muestra el estado y el gesto es el mismo en todas.
//
// ── Caja ────────────────────────────────────────────────────────────────
//
// `--row-h` de alto como cualquier control de fila, `--radius-sm` como los
// chips, y el color del sistema para "activo" (`--accent`) contra el neutro de
// reposo. Nada de hex: DESIGN_SYSTEM.md, checklist de UI.

const props = withDefaults(
  defineProps<{
    /** Prendido. */
    modelValue: boolean
    /** Texto al lado del interruptor. Vacío = sólo el interruptor. */
    label?: string
    /** Se lee sin poder tocarse. */
    disabled?: boolean
    /** Hay una escritura en vuelo: no se puede tocar y se atenúa. */
    busy?: boolean
    /** Para lectores de pantalla cuando no hay `label` visible. */
    ariaLabel?: string
  }>(),
  { label: '', disabled: false, busy: false, ariaLabel: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle(): void {
  if (props.disabled || props.busy) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    class="tsw"
    :class="{ 'tsw--on': modelValue, 'tsw--busy': busy }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="ariaLabel || label || undefined"
    :disabled="disabled || busy"
    @click.stop="toggle"
  >
    <span class="tsw__track"><span class="tsw__knob" /></span>
    <span v-if="label" class="tsw__label">{{ label }}</span>
  </button>
</template>

<style scoped>
.tsw {
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  height: var(--row-h);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  cursor: pointer;
}

.tsw__track {
  position: relative;
  display: inline-block;
  /* Dos "casillas" de ancho: el recorrido del knob tiene que leerse de un
     vistazo en una lista, y menos que esto se confunde con un checkbox. */
  width: 2rem;
  height: 0.85rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  transition: background 90ms linear, border-color 90ms linear;
}

.tsw__knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 0.7rem;
  height: calc(100% - 2px);
  background: var(--fg-dim);
  border-radius: var(--radius-sm);
  transition: transform 90ms linear, background 90ms linear;
}

.tsw--on .tsw__track { background: var(--green-bg); border-color: var(--accent); }
.tsw--on .tsw__knob { background: var(--accent); transform: translateX(calc(2rem - 0.7rem - 4px)); }
.tsw--on .tsw__label { color: var(--fg-mute); }

.tsw:hover:not(:disabled) .tsw__track { border-color: var(--accent); }
.tsw:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.tsw:disabled { cursor: default; opacity: 0.5; }
.tsw--busy .tsw__knob { opacity: 0.6; }
</style>
