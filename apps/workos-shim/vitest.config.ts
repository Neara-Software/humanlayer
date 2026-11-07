import { base } from '@humanlayer/vitest-config'
import { defineConfig, mergeConfig } from 'vitest/config'

// authkit-js ships its TypeScript sources; inline it so the test can use its real HttpClient.
export default mergeConfig(base, defineConfig({ test: { server: { deps: { inline: [/@workos-inc\/authkit-js/] } } } }))
