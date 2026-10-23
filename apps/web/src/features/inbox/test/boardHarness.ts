import { defineComponent, h, onBeforeUnmount, onMounted } from 'vue'
import EpicDetailDrawer from '@/features/inbox/EpicDetailDrawer.vue'
import MineBoard from '@/features/inbox/MineBoard.vue'
import NextBoard from '@/features/inbox/NextBoard.vue'
import RunningBoard from '@/features/inbox/RunningBoard.vue'
import { useInboxStore } from '@/features/inbox/store'
import TaskDetailDrawer from '@/features/inbox/TaskDetailDrawer.vue'

/**
 * La bandeja entera para los tests de comportamiento: las tres vistas una debajo de la otra, los
 * detalles y el ciclo de vida que en la app pone `AppShell` (arrancar al montar, cortar el stream
 * al desmontar). `RouterLink` va stubbeado por quien monta.
 */
export const BoardHarness = defineComponent({
  name: 'BoardHarness',
  setup() {
    const store = useInboxStore()
    onMounted(() => store.start())
    onBeforeUnmount(() => store.stop())
    return () =>
      h('div', [
        h(MineBoard),
        h(RunningBoard),
        h(NextBoard),
        h(TaskDetailDrawer),
        h(EpicDetailDrawer),
      ])
  },
})
