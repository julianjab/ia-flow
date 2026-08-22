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
// Dos owners distintos a propósito: `loadedOwner` es de quién son los repos
// que hay AHORA en `repos` (lo que `options` puede ofrecer sin mentir), e
// `inflightOwner` es el pedido en curso (dedupe por tecla + guarda de race).
// Con uno solo, la ventana entre el pedido y su respuesta ofrecía los repos
// del owner anterior re-etiquetados con el nuevo.
const loadedOwner = ref('');
const inflightOwner = ref('');

// El owner tipeado, aunque el repo todavía no esté completo: es lo que decide
// qué sugerencias mostrar mientras se escribe `julianjab/…`.
//
// Vale sólo una vez que hay barra. Sin ese gate, cada tecla era un owner
// distinto (`j`, `ju`, `jul`…) y cada uno una request a la API de GitHub —
// diez para tipear un owner, contra un rate limit que no sobra — y encima
// `options` pasaba a "repos de `j`" (vacío) apenas resolvía el primer
// prefijo, matando el buscador de owners justo cuando se lo necesita.
const typedOwner = computed(() =>
  slug.value.includes('/') ? parseGithubOwner(slug.value) : '',
);

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
  if (!owner || owner === inflightOwner.value || owner === loadedOwner.value) return;
  inflightOwner.value = owner;
  reposLoading.value = true;
  reposError.value = '';
  try {
    const res = await getRepos(owner);
    // Se siguió tipeando y ya hay otro owner en curso: descartar, o esta
    // respuesta lenta pisaría la lista del owner que se está buscando ahora.
    if (inflightOwner.value !== owner) return;
    repos.value = res.repos ?? [];
    loadedOwner.value = owner;
    reposError.value = res.error ?? '';
  } catch (e) {
    if (inflightOwner.value !== owner) return;
    // Owner inexistente (pasa seguido a mitad de tipeo): sin vaciar, options
    // seguiría ofreciendo los repos del owner anterior bajo este nombre.
    // `loadedOwner` igual queda seteado — "de este owner sabemos que no hay
    // lista" — o el reintento de abajo lo pediría en loop.
    repos.value = [];
    loadedOwner.value = owner;
    reposError.value = extractErrorMessage(e);
  } finally {
    // La request vieja no apaga el spinner de la nueva.
    if (inflightOwner.value === owner) {
      inflightOwner.value = '';
      reposLoading.value = false;
      // Mientras esto estaba en vuelo se pudo volver a un owner ya cargado
      // (tipear `ab` y borrar la `b`): ese `loadRepos` salió temprano y el
      // watch de typedOwner no se dispara de nuevo, así que sin este
      // reintento sus repos no se cargarían nunca.
      if (typedOwner.value && typedOwner.value !== loadedOwner.value) {
        void loadRepos(typedOwner.value);
      }
    }
  }
}

void loadOwners();
if (props.owner) void loadRepos(props.owner);

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
