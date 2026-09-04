<script setup lang="ts">
// La caja de una fila editable. Una sola pieza para TODAS las listas de
// información que se pueden editar (repos, system prompts, agentes, statuses,
// reglas, acciones, tools, catálogo MCP): el borde, el hover, el ✕ y el área
// de click son los mismos en todas, y cuando cada sección los escribía por su
// cuenta el mismo gesto se veía distinto en cada pantalla —y la mitad de las
// copias se quedó en tokens de v3 (radios de 8px, hex hardcodeados).
//
// El contenido NO es asunto de este componente: cada lista lo pone por el slot
// por defecto, y las operaciones extra (↑ ↓, ↺) por el slot `actions`.
const props = withDefaults(
  defineProps<{
    /** La fila entera abre el editor. El lápiz al final era un blanco de 24px
     *  en un teléfono y no decía qué editaba; esto mide toda la fila. */
    clickable?: boolean
    /** Botón "Editar" explícito. **Opt-in**, y no "cuando la fila no es
     *  clickable": una fila NO clickable es justamente la que no se puede
     *  editar (un deploy por YAML), así que derivarlo ofrecía el camino al
     *  detalle exactamente donde no debía haberlo. Además era inalcanzable —
     *  Vue castea un prop `Boolean` ausente a `false`, nunca a `undefined`,
     *  así que el `?? !clickable` nunca corría. */
    showEditButton?: boolean
    /** El ✕ en la fila. **Opt-in**: borrar vive en la vista de edición, no en
     *  el listado — se hace una vez, no se deshace, y desde el detalle se ve
     *  QUÉ se está por borrar en vez de un ✕ pegado al gesto de reordenar.
     *  Sólo lo prende una lista que no tenga vista de edición (las tools, que
     *  se editan en el sitio). */
    deletable?: boolean
    deleteLabel?: string
    /** Se atenúa: deshabilitada, read-only, o de otro ámbito. */
    muted?: boolean
  }>(),
  { deletable: false, showEditButton: false },
)

const emit = defineEmits<{
  edit: []
  delete: []
}>()

/**
 * Abrir el editor con el teclado.
 *
 * Dos cosas que NO se pueden expresar con `@keydown.enter` / `.space.prevent`
 * en el template, y que costaron caro:
 *
 * - Los modificadores corren ANTES que la expresión, así que un `.prevent` ahí
 *   frena la tecla incluso en una fila no clickable. El keydown burbujea desde
 *   el contenido del slot, y `ToolsSection` mete un `<textarea>` adentro: no se
 *   podía escribir un espacio en la descripción de una tool.
 * - `@click.stop` en las acciones frena el MOUSE, no el teclado. Un Enter sobre
 *   el toggle de `AgentCard` abría además el editor, y un espacio lo abría EN
 *   VEZ de activar el botón.
 *
 * Por eso el gate es doble: sólo si la fila es clickable, y sólo si la tecla
 * llegó a la fila misma y no a un control anidado.
 */
function onKeydown(e: KeyboardEvent) {
  if (!props.clickable) return
  if (e.target !== e.currentTarget) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  emit('edit')
}
</script>

<template>
  <div
    class="editable-card"
    :class="{ 'editable-card--clickable': clickable, 'editable-card--muted': muted }"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    @click="clickable ? emit('edit') : undefined"
    @keydown="onKeydown"
  >
    <div class="editable-card__body">
      <slot />
    </div>

    <!-- `.stop` para que ninguna operación abra el editor de paso. -->
    <div class="editable-card__actions" @click.stop>
      <slot name="actions" />
      <button
        v-if="showEditButton"
        type="button"
        class="ec-btn"
        @click="emit('edit')"
      >Editar</button>
      <button
        v-if="deletable"
        type="button"
        class="ec-btn ec-btn--danger"
        :aria-label="deleteLabel ?? 'Eliminar'"
        :title="deleteLabel ?? 'Eliminar'"
        @click="emit('delete')"
      >✕</button>
    </div>
  </div>
</template>

<style scoped>
.editable-card {
  display: flex;
  /* `flex-start` y no `center`: el cuerpo puede ser de una línea (una acción) o
     de cuatro (una regla con su frase y sus runs vivos), y centrar deja el ✕
     flotando en el medio de una tarjeta alta. */
  align-items: flex-start;
  gap: 0.5rem;
  /* Envuelve en vez de desbordar: en un celular estas filas tienen nombre,
     descripción y botones, y en una sola línea empujan la página. */
  flex-wrap: wrap;
  padding: 0.65rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  font-size: var(--fs-body-sm);
  line-height: var(--row-h);
  min-height: var(--row-h);
  transition: border-color 0.12s, background 0.12s, opacity 0.12s;
}

.editable-card--clickable {
  cursor: pointer;
}
.editable-card--clickable:hover,
.editable-card--clickable:focus-visible {
  border-color: var(--accent);
  background: var(--panel-hi);
}

.editable-card--muted {
  opacity: 0.7;
}
.editable-card--muted:hover {
  opacity: 1;
}

.editable-card__body {
  flex: 1 1 auto;
  min-width: 0;
}

.editable-card__actions {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-shrink: 0;
}

/* `:slotted` para que una operación extra (↑ ↓, ↺) puesta por la lista se vea
   igual que el ✕ sin que cada sección re-escriba el botón —y sin exportar la
   clase a `theme.css`, que la volvería global para toda la app. */
.ec-btn,
.editable-card__actions :slotted(button) {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.5ch;
  min-width: var(--row-h);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.1s, color 0.1s, background 0.1s;
}
.ec-btn:hover,
.editable-card__actions :slotted(button:hover) {
  border-color: var(--accent);
  color: var(--accent);
}
.ec-btn:disabled,
.editable-card__actions :slotted(button:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}
.ec-btn:disabled:hover,
.editable-card__actions :slotted(button:disabled:hover) {
  border-color: var(--border);
  color: var(--fg-mute);
}

.ec-btn--danger {
  border-color: var(--border);
  color: var(--fg-dim);
}
.ec-btn--danger:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--red-bg);
}
</style>
