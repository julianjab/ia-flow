<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();

interface Card {
  id: string;
  label: string;
  icon: string;
  description: string;
}

const CARDS: Card[] = [
  { id: 'agentes',       label: 'Agentes globales',       icon: '🤖', description: 'Agentes disponibles en todos los proyectos.' },
  { id: 'system-prompts', label: 'System Prompts',        icon: '📝', description: 'Bibliotecas de prompts reutilizables.' },
  { id: 'providers',     label: 'AI Providers',           icon: '🔌', description: 'Configuración de Claude API / terminal.' },
  { id: 'entorno',       label: 'Entorno',                icon: '🌱', description: 'Variables de entorno del server.' },
];

function open(card: Card) {
  void router.push(`/general/${card.id}`);
}
</script>

<template>
  <header class="general-header">
    <h1>General</h1>
    <p>Configuración que aplica a todos los proyectos.</p>
  </header>

  <section class="general-cards">
    <button
      v-for="card in CARDS"
      :key="card.id"
      class="general-card"
      :data-testid="`general-card-${card.id}`"
      @click="open(card)"
    >
      <span class="general-card__icon">{{ card.icon }}</span>
      <span class="general-card__body">
        <span class="general-card__label">{{ card.label }}</span>
        <span class="general-card__desc">{{ card.description }}</span>
      </span>
    </button>
  </section>
</template>

<style scoped>
.general-header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
.general-header p  { margin: 0; color: #6b7280; font-size: 0.9rem; }

.general-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}
.general-card {
  display: flex;
  gap: 0.85rem;
  align-items: flex-start;
  padding: 1rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.general-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  transform: translateY(-1px);
}
.general-card__icon { font-size: 1.5rem; line-height: 1; }
.general-card__body { display: flex; flex-direction: column; gap: 0.15rem; }
.general-card__label { font-weight: 600; font-size: 0.95rem; }
.general-card__desc  { color: #6b7280; font-size: 0.85rem; }
</style>
