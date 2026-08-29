<script setup lang="ts">
// Dónde aterriza el trabajo en la máquina del agent-host.
//
// Es la config que antes sólo se cambiaba editando el `.env` y reiniciando el
// proceso. `reposBase` es la que más falta: sin ella, un run que necesita un
// repo que esa máquina nunca vio falla en `ensureLocalClone`.

import { ref, watch } from 'vue'
import type { AgentHostWorkspace } from './api'

const props = defineProps<{ modelValue: AgentHostWorkspace | null; saving: boolean }>()
const emit = defineEmits<{ save: [value: AgentHostWorkspace] }>()

const form = ref<AgentHostWorkspace>({
  reposBase: null,
  worktreeBase: null,
  gitAuthorName: null,
  gitAuthorEmail: null,
})

/** El console re-lee el agent-host cada 5s y entrega un objeto NUEVO cada vuelta.
 *  Re-sembrar el form con cada lectura borraba lo que el usuario estaba
 *  tipeando; sólo re-sembramos cuando lo que guardó el agent-host cambió de
 *  verdad (nuestro propio guardado, o alguien editando desde otra pantalla). */
let seeded: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (!next) return
    const snapshot = JSON.stringify(next)
    if (snapshot === seeded) return
    seeded = snapshot
    form.value = { ...next }
  },
  { immediate: true },
)

/** El input emite `''`; el agent-host distingue null (no configurado, usa su
 *  default) de un string. Sin esto guardaríamos cadenas vacías. */
function set(key: keyof AgentHostWorkspace, raw: string): void {
  form.value[key] = raw.trim() ? raw : null
}
</script>

<template>
  <section class="panel">
    <header class="panel__header">workspace</header>
    <div class="body">
      <p class="hint">
        Dónde clona y dónde trabaja esta máquina. Vacío = el default del proceso.
      </p>

      <label class="field">
        <span class="uc-label">base de clones</span>
        <input
          class="field__input"
          :value="form.reposBase ?? ''"
          placeholder="/Users/vos/ia-flow-repos"
          spellcheck="false"
          @input="set('reposBase', ($event.target as HTMLInputElement).value)"
        />
        <span class="hint hint--tight">
          Sin esto, un repo que esta máquina nunca vio no se puede clonar y el run falla.
        </span>
      </label>

      <label class="field">
        <span class="uc-label">base de worktrees</span>
        <input
          class="field__input"
          :value="form.worktreeBase ?? ''"
          placeholder="/tmp/ia-flow"
          spellcheck="false"
          @input="set('worktreeBase', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <div class="row">
        <label class="field field--half">
          <span class="uc-label">autor de los commits</span>
          <input
            class="field__input"
            :value="form.gitAuthorName ?? ''"
            placeholder="ia-flow-bot"
            spellcheck="false"
            @input="set('gitAuthorName', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field field--half">
          <span class="uc-label">email</span>
          <input
            class="field__input"
            :value="form.gitAuthorEmail ?? ''"
            placeholder="bot@ia-flow.local"
            spellcheck="false"
            @input="set('gitAuthorEmail', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>

      <button class="btn btn--primary" :disabled="saving" @click="emit('save', { ...form })">
        {{ saving ? 'guardando…' : 'guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.body {
  padding: 0.75rem;
}
.hint {
  margin: 0 0 0.75rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.hint--tight {
  display: block;
  margin: 0.25rem 0 0;
}
.field {
  display: block;
  margin-bottom: 0.75rem;
}
.field--half {
  flex: 1;
}
.row {
  display: flex;
  gap: 0.5rem;
}
.field__input {
  width: 100%;
  margin-top: 0.25rem;
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.field__input:focus {
  outline: none;
  border-color: var(--border-hi);
}
</style>
