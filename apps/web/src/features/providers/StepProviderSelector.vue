<script setup lang="ts">
import { computed } from 'vue';
import type { Provider, ProviderId, StepId } from '@/features/providers/store';

const props = defineProps<{
  step: StepId;
  providers: Provider[];
  modelValue: ProviderId;
  label?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: ProviderId): void;
}>();

const selectId = computed(() => `step-provider-${props.step}`);

function onChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('update:modelValue', target.value as ProviderId);
}
</script>

<template>
  <div class="step-provider-selector">
    <label :for="selectId">{{ label ?? step }}</label>
    <select
      :id="selectId"
      :value="modelValue"
      :data-step="step"
      @change="onChange"
    >
      <option
        v-for="provider in providers"
        :key="provider.id"
        :value="provider.id"
      >
        {{ provider.name ?? provider.id }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.step-provider-selector {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
}
.step-provider-selector label {
  min-width: 12rem;
  font-weight: 500;
  text-transform: capitalize;
}
.step-provider-selector select {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
}
</style>
