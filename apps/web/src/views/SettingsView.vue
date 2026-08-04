<script setup lang="ts">
// Stub view: subsequent PRs will populate provider selectors, Anthropic form
// and the system prompt editor.
</script>

<template>
  <section class="settings-view">
    <header class="settings-header">
      <h1>Providers Settings</h1>
    </header>

    <section class="settings-section" data-slot="step-providers">
      <!-- TODO: step provider selectors -->
    </section>

    <section class="settings-section" data-slot="anthropic-form">
      <!-- TODO: Anthropic API settings form -->
    </section>

    <section class="settings-section" data-slot="system-prompt-editor">
      <!-- TODO: system prompt editor with draggable variable chips -->
    </section>
  </section>
</template>

<style scoped>
.settings-view {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.settings-header h1 {
  margin: 0;
  font-size: 1.75rem;
}
.settings-section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  min-height: 3rem;
}
</style>
