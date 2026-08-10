<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import GlobalSystemPromptsSection from '@/features/project-config/GlobalSystemPromptsSection.vue';
import ProvidersSection from '@/features/providers/ProvidersSection.vue';
import EntornoSection from '@/features/env-vars/EntornoSection.vue';

const props = defineProps<{ section: string }>();

const router = useRouter();

const TITLE_MAP: Record<string, string> = {
  'agentes':        'Agentes globales',
  'system-prompts': 'System Prompts globales',
  'providers':      'AI Providers',
  'entorno':        'Entorno',
};

const title = computed(() => TITLE_MAP[props.section] ?? 'General');

function goBack() {
  void router.push('/general');
}
</script>

<template>
  <header class="section-header">
    <button class="section-header__back" @click="goBack">← General</button>
    <h1>{{ title }}</h1>
  </header>

  <AgentesSection              v-if="section === 'agentes'"        scope="global" />
  <GlobalSystemPromptsSection  v-else-if="section === 'system-prompts'" />
  <ProvidersSection            v-else-if="section === 'providers'" />
  <EntornoSection              v-else-if="section === 'entorno'" />

  <div v-else class="section-empty">Sección desconocida: {{ section }}</div>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.section-header h1 {
  margin: 0;
  font-size: 1.5rem;
}
.section-header__back {
  background: none;
  border: none;
  color: #4b5563;
  cursor: pointer;
  font-size: 0.85rem;
}
.section-header__back:hover { color: #111827; }
.section-empty {
  padding: 2rem;
  color: #6b7280;
  text-align: center;
  background: #f9fafb;
  border-radius: 8px;
}
</style>
