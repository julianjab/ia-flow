import { describe, expect, it } from 'vitest'
import { withoutTemplates } from '@/features/inbox/labels'

describe('withoutTemplates', () => {
  it('cambia cada {{…}} por «…» y junta las que quedan pegadas', () => {
    expect(withoutTemplates('Review + reviewed{{fmt.pr}}')).toBe('Review + reviewed…')
    expect(withoutTemplates('{{fmt.who}} corriendo{{fmt.tokens}}')).toBe('… corriendo…')
    expect(withoutTemplates('Pausada en {{fmt.pause}}{{fmt.expires}}')).toBe('Pausada en …')
  })

  it('un texto sin plantillas queda igual', () => {
    expect(withoutTemplates('Decidir el merge')).toBe('Decidir el merge')
  })
})
