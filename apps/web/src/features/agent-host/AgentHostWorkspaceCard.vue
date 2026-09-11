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
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>workspace</h2>
        <p class="section-desc">
          Dónde clona y dónde trabaja esta máquina. Vacío = el default del proceso.
        </p>
      </div>
    </div>
    <div class="body">
      <div class="ff-col">
        <label class="ff-row">
          <span class="uc-label">base de clones</span>
          <input
            class="ff-field ff-mono"
            :value="form.reposBase ?? ''"
            placeholder="/Users/vos/ia-flow-repos"
            spellcheck="false"
            @input="set('reposBase', ($event.target as HTMLInputElement).value)"
          />
          <span class="ff-hint">
            Sin esto, un repo que esta máquina nunca vio no se puede clonar y el run falla.
          </span>
        </label>

        <label class="ff-row">
          <span class="uc-label">base de worktrees</span>
          <input
            class="ff-field ff-mono"
            :value="form.worktreeBase ?? ''"
            placeholder="/tmp/ia-flow"
            spellcheck="false"
            @input="set('worktreeBase', ($event.target as HTMLInputElement).value)"
          />
        </label>

        <div class="ff-row-split">
          <label class="ff-sub">
            <span class="uc-label">autor de los commits</span>
            <input
              class="ff-field ff-mono"
              :value="form.gitAuthorName ?? ''"
              placeholder="ia-flow-bot"
              spellcheck="false"
              @input="set('gitAuthorName', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="ff-sub">
            <span class="uc-label">email</span>
            <input
              class="ff-field ff-mono"
              :value="form.gitAuthorEmail ?? ''"
              placeholder="bot@ia-flow.local"
              spellcheck="false"
              @input="set('gitAuthorEmail', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>

      <button class="btn btn--primary save" :disabled="saving" @click="emit('save', { ...form })">
        {{ saving ? 'guardando…' : 'guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.save {
  align-self: flex-start;
}
</style>
