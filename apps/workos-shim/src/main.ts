import { createApp } from './app'
import { loadConfig } from './config'
import { postgresDb } from './db'

const cfg = loadConfig()
const app = await createApp(cfg, postgresDb(cfg.databaseUrl))
const server = Bun.serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host })
console.log(`workos-shim listening on http://${server.hostname}:${server.port} as ${cfg.publicOrigin}`)
