<script setup lang="ts">
import type { AssistantScope } from '@ia-flow/shared';
import { computed } from 'vue';
import { scopeLabel } from '@/features/assistant/scope';

// El contexto de una conversación como etiqueta: tarea en ámbar, proyecto en
// celeste, todo el runner en el acento. El color lo da el texto; la caja es una.

const props = defineProps<{ scope: AssistantScope }>();
const glyph = computed(() => (props.scope.kind === 'task' ? '#' : props.scope.kind === 'project' ? '@' : '◎'));
const text = computed(() => scopeLabel(props.scope).replace(/^#/, ''));
</script>

<template>
  <span class="tag mono" :data-kind="scope.kind"><span aria-hidden="true">{{ glyph }}</span> {{ text }}</span>
</template>

<style scoped>
.tag {
  display: inline-block;
  max-width: 100%;
  padding: 0 0.4rem;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.tag[data-kind='task'] { color: var(--warn); }
.tag[data-kind='project'] { color: var(--info); }
.tag[data-kind='general'] { color: var(--accent); }
</style>
