import { describe, expect, it } from 'bun:test'
import { type RepoPromptEntry, repoPromptsText } from './repoPrompts.js'

const catalog: RepoPromptEntry[] = [
  { name: 'api', githubOwner: 'la-haus', githubRepo: 'api', prompt: 'Corré `make test`.\n' },
  { name: 'web', githubOwner: 'la-haus', githubRepo: 'web-front', prompt: 'Usá Tailwind.' },
  { name: 'docs', githubOwner: 'la-haus', githubRepo: 'docs' },
  { name: 'tools', prompt: 'Sin owner ni githubRepo: se reconoce por el nombre.' },
]

describe('repoPromptsText', () => {
  it('arma una sección por repo de la task, con el name del catálogo', () => {
    expect(repoPromptsText(catalog, 'la-haus', ['api'])).toBe(
      '## Notas del repo `api`\n\nCorré `make test`.',
    )
  })

  it('una task en A no ve las notas de B', () => {
    const text = repoPromptsText(catalog, 'la-haus', ['api'])
    expect(text).not.toContain('Tailwind')
    expect(text).not.toContain('`web`')
  })

  it('una task con varios repos trae las notas de cada uno, en su orden', () => {
    expect(repoPromptsText(catalog, 'la-haus', ['web-front', 'api'])).toBe(
      '## Notas del repo `web`\n\nUsá Tailwind.\n\n## Notas del repo `api`\n\nCorré `make test`.',
    )
  })

  it('un repo sin prompt, o fuera del catálogo, no agrega nada', () => {
    expect(repoPromptsText(catalog, 'la-haus', ['docs'])).toBe('')
    expect(repoPromptsText(catalog, 'la-haus', ['otro'])).toBe('')
    expect(repoPromptsText(catalog, 'la-haus', ['docs', 'api'])).toBe(
      '## Notas del repo `api`\n\nCorré `make test`.',
    )
    expect(repoPromptsText(undefined, 'la-haus', ['api'])).toBe('')
  })

  it('compara owner y repo sin mayúsculas, y el owner tiene que coincidir', () => {
    expect(repoPromptsText(catalog, 'La-Haus', ['API'])).toContain('make test')
    expect(repoPromptsText(catalog, 'otra-org', ['api'])).toBe('')
  })

  it('un repo del catálogo sin githubRepo se reconoce por su name, con cualquier owner', () => {
    expect(repoPromptsText(catalog, 'quien-sea', ['tools'])).toContain('por el nombre')
  })
})
