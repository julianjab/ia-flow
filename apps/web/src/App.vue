<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView } from 'vue-router';
import RateLimitBanner from './components/RateLimitBanner.vue';
import { installKeyboardNav } from '@/composables/useKeyboardNav';

onMounted(() => {
  installKeyboardNav();
});
</script>

<template>
  <RateLimitBanner />
  <RouterView />
  <div id="toast-container" class="toast-container"></div>
</template>

<style>
.toast-container {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  z-index: 1000;
}
</style>
