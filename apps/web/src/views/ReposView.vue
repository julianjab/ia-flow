<script setup lang="ts">
import ReposSection from '@/features/repos/ReposSection.vue';
</script>

<template>
  <header class="repos-view__header">
    <h1>Repos</h1>
    <p>Repositorios locales y sus mapeos a GitHub.</p>
  </header>
  <ReposSection />
</template>

<style scoped>
.repos-view__header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
.repos-view__header p  { margin: 0 0 1.5rem; color: #6b7280; font-size: 0.9rem; }
</style>
