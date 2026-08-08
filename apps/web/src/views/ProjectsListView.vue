<script setup lang="ts">
// Full list + create modal lands in the next commit. This is the shell so
// the router compiles and the sidebar navigation works end-to-end.
</script>

<template>
  <header class="projects-header">
    <h1>Proyectos</h1>
    <p>Gestión de proyectos activos.</p>
  </header>
  <div class="projects-placeholder">Próximamente: lista + creación.</div>
</template>

<style scoped>
.projects-header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
.projects-header p  { margin: 0 0 1.5rem; color: #6b7280; font-size: 0.9rem; }
.projects-placeholder {
  padding: 2rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 8px;
  text-align: center;
}
</style>
