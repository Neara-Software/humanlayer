import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The daemon's local state directory (artifacts, host_id, plugins, config, locks):
 * HUMANLAYER_RIPTIDE_HOME, else `<home>/.humanlayer/riptide`. Callers with an injected home
 * directory (Effect services, tests) pass it; the env override still wins.
 */
export function riptideHome(home: string = homedir()): string {
	return process.env.HUMANLAYER_RIPTIDE_HOME || join(home, '.humanlayer', 'riptide')
}
