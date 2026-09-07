<script setup lang="ts">
/**
 * Una línea de log — **una línea, siempre** (T7, A2).
 *
 * La regla que la define: *una línea de log no se parte en dos ni se envuelve;
 * se trunca y se abre*. Un mensaje que envuelve convierte una lista de 40
 * eventos en una pared donde no se puede barrer con la vista, que es lo único
 * que un stream se usa para hacer. El mensaje completo, el stack y el contexto
 * viven en el detalle.
 *
 * Cuatro datos en el mismo orden de lectura siempre —hora · nivel · origen ·
 * mensaje— porque un stream se escanea por posición, no leyendo cada campo.
 *
 * El nivel es **el color de un glifo**, no un fondo ni un badge: cuarenta
 * badges de colores en una columna se leen como una alarma constante, y el
 * glifo deja el peso visual para el mensaje, que es el dato.
 */
withDefaults(
  defineProps<{
    /** Ya formateada por quien la tiene: `HH:MM:SS`, o `DD mmm HH:MM` si es de
     *  otro día. Este componente no sabe de zonas horarias ni de locales. */
    time: string;
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    /** El módulo, el agente, la regla — quién habla. */
    origin?: string;
    message: string;
    /** Se resalta como la fila abierta del stream. */
    active?: boolean;
  }>(),
  { active: false },
);

/** Un glifo por nivel. `error` y `fatal` comparten el ✕: para quien mira la
 *  lista son lo mismo —algo se rompió— y la diferencia vive en el detalle. */
const GLYPH: Record<string, string> = {
  trace: '·',
  debug: '·',
  info: '●',
  warn: '▲',
  error: '✕',
  fatal: '✕',
};
</script>

<template>
  <div class="ll" :class="[`ll--${level}`, { 'll--active': active }]">
    <span class="ll__time">{{ time }}</span>
    <span class="ll__glyph" :title="level" aria-hidden="true">{{ GLYPH[level] ?? '·' }}</span>
    <span v-if="origin" class="ll__origin">{{ origin }}</span>
    <span class="ll__msg" :title="message">{{ message }}</span>
  </div>
</template>

<style scoped>
.ll {
  display: flex;
  align-items: center;
  gap: 0.75ch;
  /* --row-h: es grilla. La línea se MIRA; abrirla es del contenedor, que le
     da su propio blanco táctil si la fila es clickeable. */
  min-height: var(--row-h);
  padding: 0 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-mute);
  /* Lo que hace que sea UNA línea: sin esto, un mensaje largo envuelve y la
     lista deja de poder barrerse con la vista. */
  white-space: nowrap;
  overflow: hidden;
}
.ll--active { background: var(--panel-hi); color: var(--fg); }

.ll__time { flex: 0 0 auto; color: var(--fg-dimmer); font-variant-numeric: tabular-nums; }
/* El nivel es el color del GLIFO, no un fondo: cuarenta badges en una columna
   se leen como una alarma constante. */
.ll__glyph { flex: 0 0 auto; color: var(--fg-dimmer); }
.ll--info .ll__glyph { color: var(--info); }
.ll--warn .ll__glyph { color: var(--warn); }
.ll--error .ll__glyph,
.ll--fatal .ll__glyph { color: var(--danger); }

.ll__origin {
  flex: 0 0 auto;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-dim);
}
/* El mensaje cede último y es el que se trunca: es el dato, y lo que sobra
   está en el detalle. */
.ll__msg {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: inherit;
}

/* Bajo --bp-stack el origen sale de la línea: en 390px se llevaba 14ch que el
   mensaje necesita más. Sigue estando en el detalle. */
@media (max-width: 640px) {
  .ll__origin { display: none; }
}
</style>
