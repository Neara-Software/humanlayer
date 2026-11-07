import { parseArgs } from 'node:util'

import { type Db, migrate, one, oneOrThrow, postgresDb } from './db'
import { newId } from './ids'
import { addSigningKey } from './keys'

const usage = `Usage:
  bun src/cli.ts seed --org-name <name> --riptide-database-url <url> [--database-url <url>]
  bun src/cli.ts rotate-key [--database-url <url>]

--database-url defaults to SHIM_DATABASE_URL.`

/**
 * Creates the shim org and its riptide `organizations` row, linked both ways
 * (riptide workos_organization_id = shim org id; shim metadata.internal_org_id = riptide uuid).
 * Safe to re-run: it reuses the shim org with the same name and the riptide row that points at it.
 */
export async function seed(db: Db, riptide: Db, orgName: string): Promise<{ orgId: string; internalOrgId: string }> {
	await migrate(db)
	const org =
		(await one<{ id: string }>(db, 'SELECT id FROM organizations WHERE name = $1 ORDER BY id LIMIT 1', [
			orgName,
		])) ??
		(await oneOrThrow<{ id: string }>(db, 'INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id', [
			newId('org'),
			orgName,
		]))
	const row = await oneOrThrow<{ id: string }>(
		riptide,
		`WITH existing AS (SELECT id FROM organizations WHERE workos_organization_id = $2 LIMIT 1),
		inserted AS (
			INSERT INTO organizations (name, workos_organization_id)
			SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM existing)
			RETURNING id
		)
		SELECT id::text FROM existing UNION ALL SELECT id::text FROM inserted`,
		[orgName, org.id],
	)
	await db.query(
		`UPDATE organizations SET metadata = metadata || jsonb_build_object('internal_org_id', $2::text), updated_at = now() WHERE id = $1`,
		[org.id, row.id],
	)
	return { orgId: org.id, internalOrgId: row.id }
}

if (import.meta.main) {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			'org-name': { type: 'string' },
			'riptide-database-url': { type: 'string' },
			'database-url': { type: 'string', default: process.env.SHIM_DATABASE_URL },
		},
	})
	const command = positionals[0]
	const databaseUrl = values['database-url']
	if (!databaseUrl || (command !== 'seed' && command !== 'rotate-key')) {
		console.error(usage)
		process.exit(1)
	}
	const db = postgresDb(databaseUrl)
	try {
		if (command === 'seed') {
			if (!values['org-name'] || !values['riptide-database-url']) {
				console.error(usage)
				process.exit(1)
			}
			const riptide = postgresDb(values['riptide-database-url'], 'public')
			try {
				const { orgId, internalOrgId } = await seed(db, riptide, values['org-name'])
				console.error(`riptide organizations.id = ${internalOrgId}`)
				console.log(`SHIM_DEFAULT_ORG_ID=${orgId}`)
			} finally {
				await riptide.close()
			}
		} else {
			await migrate(db)
			console.log(`added signing key ${await addSigningKey(db)}; it signs new tokens from now on`)
		}
	} finally {
		await db.close()
	}
}
