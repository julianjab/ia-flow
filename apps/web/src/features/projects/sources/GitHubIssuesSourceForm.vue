<script setup lang="ts">
import { computed, ref, watch } from 'vue';

// Config shape for source.kind === 'github-issues' — la valida
// createDefaultSourceFactory (packages/issue-sources/src/source-factory.ts):
// owner + repo obligatorios, anchorLabel opcional.
//
// El usuario pega la URL del repo y acá se parte en owner/repo: es el mismo
// dato en el formato en que uno lo tiene a mano (la barra del navegador),
// y deja el form simétrico con el de github (Projects v2), que también es
// una sola URL. El config guardado sigue siendo owner/repo — la URL no se
// persiste, se re-deriva al abrir el form.
export interface GitHubIssuesSourceConfig {
  owner?: string;
  repo?: string;
  anchorLabel?: string;
}

const props = defineProps<{ modelValue: GitHubIssuesSourceConfig }>();
const emit = defineEmits<{ 'update:modelValue': [value: GitHubIssuesSourceConfig] }>();

// Acepta la URL del repo (con o sin https://, con /issues, .git o barra final)
// y el atajo owner/repo. Cualquier otra cosa es un error visible en el form,
// no un config a medio llenar guardado en silencio.
function parseRepoUrl(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const path = trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '');
  const [owner, repo] = path.split('/').filter(Boolean);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function urlFor(config: GitHubIssuesSourceConfig): string {
  return config.owner && config.repo ? `https://github.com/${config.owner}/${config.repo}` : '';
}

const url = ref(urlFor(props.modelValue));
const parsed = computed(() => parseRepoUrl(url.value));

// Resync cuando el config cambia por fuera (cambiar de proyecto en la pestaña
// Provider), sin pisar lo que el usuario está tipeando: si lo tipeado ya
// parsea a este owner/repo, la URL en pantalla es la misma y no se toca.
watch(
  () => `${props.modelValue.owner ?? ''}/${props.modelValue.repo ?? ''}`,
  () => {
    if (parsed.value?.owner === props.modelValue.owner && parsed.value?.repo === props.modelValue.repo) return;
    url.value = urlFor(props.modelValue);
  },
);

function onUrlInput(e: Event) {
  url.value = (e.target as HTMLInputElement).value;
  const next = parsed.value;
  emit('update:modelValue', {
    ...props.modelValue,
    owner: next?.owner ?? '',
    repo: next?.repo ?? '',
  });
}

const anchorLabel = computed({
  get: () => props.modelValue.anchorLabel ?? '',
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, anchorLabel: v }),
});
</script>

<template>
  <div class="gisf">
    <label class="gisf-field">
      <span class="gisf-label">GitHub Repo URL</span>
      <input
        :value="url"
        class="gisf-input"
        placeholder="https://github.com/julianjab/accountant"
        @input="onUrlInput"
      />
      <span v-if="url && !parsed" class="gisf-error">
        No parece una URL de repo. Formato: https://github.com/owner/repo
      </span>
      <span v-else-if="parsed" class="gisf-hint">
        owner <strong>{{ parsed.owner }}</strong> · repo <strong>{{ parsed.repo }}</strong>
      </span>
    </label>

    <label class="gisf-field">
      <span class="gisf-label">Anchor label</span>
      <input v-model="anchorLabel" class="gisf-input" placeholder="ia-flow" />
      <span class="gisf-hint">
        Opcional: sólo los issues con esta label entran al scan, y el engine se la
        pone sola a los que crea. Vacío = todo issue abierto del repo es candidato
        (ok en un repo dedicado al engine, riesgoso en uno compartido con humanos).
      </span>
    </label>
  </div>
</template>

<style scoped>
.gisf { display: flex; flex-direction: column; gap: 0.75rem; }
.gisf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.gisf-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.gisf-hint { font-size: 0.75rem; color: var(--fg-dim); }
.gisf-error { font-size: 0.75rem; color: var(--danger); }
.gisf-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.9rem;
}
</style>
