import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { riptideHome } from '@/lib/riptide-home'
import logger from '@/logger'

function hostIdFile(): string {
	const stackId = process.env.DEVSTACK_ID
	return join(riptideHome(), stackId ? `host_id_${stackId}` : 'host_id')
}

// Cache for the host ID
let cachedHostId: string | null = null

/**
 * Get or create the host ID for this machine.
 * The host ID is persisted to ~/.humanlayer/riptide/host_id
 */
export async function getHostId(): Promise<string> {
	if (cachedHostId) {
		return cachedHostId
	}

	// Try to read existing host_id
	try {
		const existing = (await readFile(hostIdFile(), 'utf-8')).trim()
		if (existing) {
			cachedHostId = existing
			logger.info(`Host ID: ${existing}`)
			return existing
		}
	} catch {
		// File doesn't exist or can't be read, we'll create it below
	}

	// Ensure directory exists
	await mkdir(riptideHome(), { recursive: true })

	// Generate new host_id
	const newId = crypto.randomUUID()
	await writeFile(hostIdFile(), newId)
	cachedHostId = newId

	logger.info(`Host ID: ${newId}`)
	return newId
}
