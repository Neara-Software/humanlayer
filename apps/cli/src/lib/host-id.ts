import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { credentialsDir } from '../auth/storage'

export function getHostIdFilePath(hostIdDirectory: string, stackId: string | undefined): string {
	return join(hostIdDirectory, stackId ? `host_id_${stackId}` : 'host_id')
}

function hostIdFile(): string {
	return getHostIdFilePath(credentialsDir(), process.env.DEVSTACK_ID)
}

let cachedHostId: string | null = null

export async function getHostId(): Promise<string> {
	if (cachedHostId) return cachedHostId

	try {
		const existing = (await readFile(hostIdFile(), 'utf-8')).trim()
		if (existing) {
			cachedHostId = existing
			return existing
		}
	} catch {
		// File doesn't exist, create it
	}

	await mkdir(credentialsDir(), { recursive: true })
	const newId = crypto.randomUUID()
	await writeFile(hostIdFile(), newId)
	cachedHostId = newId
	return newId
}
