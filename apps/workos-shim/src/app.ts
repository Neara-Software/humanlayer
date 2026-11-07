import { Hono } from 'hono'

import { authRoutes } from './auth'
import type { Config } from './config'
import { type Db, migrate } from './db'
import { directoryRoutes } from './directory'
import { currentSigningKey } from './keys'
import { createOidc } from './oidc'

/** Builds the shim: runs migrations and makes sure a signing key exists before serving. */
export async function createApp(cfg: Config, db: Db): Promise<Hono> {
	await migrate(db)
	await currentSigningKey(db)
	const ctx = { db, cfg, oidc: createOidc(cfg.oidc, `${cfg.publicOrigin}/user_management/callback`) }

	const app = new Hono()
	app.get('/health', (c) => c.text('ok'))
	authRoutes(app, ctx)
	directoryRoutes(app, ctx)
	app.onError((error, c) => {
		console.error(error)
		return c.json({ message: 'Internal server error' }, 500)
	})
	return app
}
