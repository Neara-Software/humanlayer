import { afterEach, describe, expect, test, vi } from 'vitest'

import { isArtifactPath } from '../../../src/agents/claudecode/whitelist'
import { getArtifactStoragePath } from '../../../src/lib/artifact-paths'
import { riptideHome } from '../../../src/lib/riptide-home'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('riptideHome', () => {
	test('defaults to <home>/.humanlayer/riptide', () => {
		vi.stubEnv('HUMANLAYER_RIPTIDE_HOME', '')
		expect(riptideHome('/home/u')).toBe('/home/u/.humanlayer/riptide')
	})

	test('HUMANLAYER_RIPTIDE_HOME moves the artifact store and the whitelist with it', () => {
		vi.stubEnv('HUMANLAYER_RIPTIDE_HOME', '/home/u/.humanlayer/riptide-self')
		expect(riptideHome('/home/u')).toBe('/home/u/.humanlayer/riptide-self')
		expect(getArtifactStoragePath('t1')).toBe('/home/u/.humanlayer/riptide-self/artifacts/t1')
		expect(isArtifactPath('/home/u/.humanlayer/riptide-self/artifacts/t1/plan.md', '/repo')).toBe(true)
		expect(isArtifactPath('/home/u/.humanlayer/riptide/artifacts/t1/plan.md', '/repo')).toBe(false)
	})
})
