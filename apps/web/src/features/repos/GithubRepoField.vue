<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import {
  formatGithubRepoSlug,
  parseGithubOwner,
  parseGithubRepoRef,
} from '@/composables/parseGithubRepoRef';
import { getOwners, getRepos, type GithubOwner } from '@/features/github/api';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';

// Un solo campo para lo que antes eran dos (un <select> de owner y un
// autocomplete de repo, duplicados en RepoConfigModal y RepoInlineForm):
// se escribe `owner/repo` o se pega la URL del repo. Las sugerencias siguen
// saliendo de la API de GitHub — owners mientras no haya `/`, repos de ese
// owner una vez que lo hay — así que no se pierde el buscador, sólo el
// paso de elegir owner antes de poder tipear nada.
const props = defineProps<{ owner: string; repo: string; id?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: { owner: string; repo: string }] }>();

const slug = ref(formatGithubRepoSlug(props));
const owners = ref<GithubOwner[]>([]);
const ownersLoading = ref(false);
const ownersError = ref('');
const repos = ref<string[]>([]);
const reposLoading = ref(false);
const reposError = ref('');
// De qué owner son los repos cargados, para no repetir el fetch en cada tecla.
const loadedOwner = ref('');

async function loadOwners() {
  ownersLoading.value = true;
  ownersError.value = '';
  try {
    const res = await getOwners();
    owners.value = res.owners ?? [];
    if (res.error) ownersError.value = res.error;
  } catch (e) {
    ownersError.value = extractErrorMessage(e);
  } finally {
    ownersLoading.value = false;
  }
}

async function loadRepos(owner: string) {
  if (!owner || owner === loadedOwner.value) return;
  loadedOwner.value = owner;
  reposLoading.value = true;
  reposError.value = '';
  try {
    const res = await getRepos(owner);
    repos.value = res.repos ?? [];
    if (res.error) reposError.value = res.error;
  } catch (e) {
    reposError.value = extractErrorMessage(e);
  } finally {
    reposLoading.value = false;
  }
}

void loadOwners();
if (props.owner) void loadRepos(props.owner);

// El owner tipeado, aunque el repo todavía no esté completo: es lo que decide
// qué sugerencias mostrar mientras se escribe `julianjab/…`.
const typedOwner = computed(() => parseGithubOwner(slug.value));

watch(typedOwner, (owner) => {
  if (owner) void loadRepos(owner);
});

const options = computed(() => {
  const owner = typedOwner.value;
  if (owner && loadedOwner.value === owner) return repos.value.map((r) => `${owner}/${r}`);
  return owners.value.map((o) => `${o.login}/`);
});

// Resync ante un cambio externo (abrir otra tarjeta de repo), sin pisar lo
// que se está tipeando: mientras el slug esté a medias emitimos vacíos y el
// padre nos los devuelve — eso no debe borrar el input.
const lastEmitted = ref(formatGithubRepoSlug(props));

watch(
  () => formatGithubRepoSlug(props),
  (incoming) => {
    if (incoming === lastEmitted.value) return;
    lastEmitted.value = incoming;
    slug.value = incoming;
  },
);

function onInput(value: string) {
  slug.value = value;
  const parsed = parseGithubRepoRef(value);
  lastEmitted.value = formatGithubRepoSlug(parsed ?? {});
  emit('update:modelValue', { owner: parsed?.owner ?? '', repo: parsed?.repo ?? '' });
}

const invalid = computed(() => !!slug.value.trim() && !parseGithubRepoRef(slug.value));
</script>

<template>
  <div class="grf">
    <AutocompleteSelect
      :id="id"
      :model-value="slug"
      :options="options"
      :loading="ownersLoading || reposLoading"
      :error="ownersError || reposError"
      placeholder="julianjab/accountant — o pegá la URL del repo"
      empty-text="Sin repos que coincidan"
      @update:model-value="onInput"
    />
    <span v-if="invalid" class="grf-error">
      Falta el repo: usá <code>owner/repo</code> o https://github.com/owner/repo
    </span>
    <span v-else class="grf-hint">Si está vacío se usa el Nombre para tareas.</span>
  </div>
</template>

<style scoped>
.grf { display: flex; flex-direction: column; gap: 0.35rem; }
.grf-hint { font-size: 0.75rem; color: var(--fg-dim); }
.grf-error { font-size: 0.75rem; color: var(--danger); }
</style>
