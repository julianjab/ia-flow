import type { Migration } from './runner.js'

// Agrega el system prompt propio del gateway: un `SystemPromptRef`
// (`packages/shared`, id del catálogo o `{text}` inline) serializado como
// JSON, que RemoteAgentProvider.run() antepone a `systemPromptBlocks` al
// despachar hacia ESA registración — ver IProviderRegistrationRepository.ts.
// Nullable: la mayoría de las registraciones no necesitan nada especial.

const migration: Migration = {
  id: '078-provider-registration-system-prompt',
  description: 'Agrega system_prompt (SystemPromptRef serializado) a provider_registrations',
  up(db) {
    db.run('ALTER TABLE provider_registrations ADD COLUMN system_prompt TEXT')
  },
}

export default migration
