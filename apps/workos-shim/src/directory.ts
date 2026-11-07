import type { Context, Hono, MiddlewareHandler } from 'hono'

import { type Db, one, oneOrThrow } from './db'
import { apiError, type Body, notFound, readBody, safeEqual, str } from './http'
import { newId, randomToken, sha256 } from './ids'
import type { ApiKeyRow, DomainRow, InvitationRow, MembershipRow, OrganizationRow, UserRow } from './rows'
import {
	apiKeyJson,
	domainJson,
	invitationJson,
	invitationState,
	membershipJson,
	organizationJson,
	userJson,
} from './serialize'
import { acceptInvitation, type Ctx, isActiveMember, upsertMembership } from './store'

const MEMBERSHIP_SELECT = `SELECT m.*, o.name AS organization_name FROM organization_memberships m
	JOIN organizations o ON o.id = m.organization_id`

interface ListQuery {
	select: string
	idColumn: string
	where: string[]
	params: unknown[]
}

/** WorkOS cursor pagination over ULID ids: `{object:'list', data, list_metadata:{before, after}}`, newest first by default. */
async function paginate<T extends { id: string }>(
	c: Context,
	db: Db,
	query: ListQuery,
	toJson: (row: T) => unknown,
): Promise<Response> {
	const q = c.req.query()
	const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 100)
	const backwards = !q.after && Boolean(q.before)
	const descending = (q.order !== 'asc') !== backwards
	const where = [...query.where]
	const params = [...query.params]
	const cursor = q.after || q.before
	if (cursor) {
		params.push(cursor)
		where.push(`${query.idColumn} ${descending ? '<' : '>'} $${params.length}`)
	}
	const rows = await db.query<T>(
		`${query.select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
		ORDER BY ${query.idColumn} ${descending ? 'DESC' : 'ASC'} LIMIT ${limit + 1}`,
		params,
	)
	const more = rows.length > limit
	const data = rows.slice(0, limit)
	if (backwards) data.reverse()
	const first = data[0]?.id ?? null
	const last = data.at(-1)?.id ?? null
	return c.json({
		object: 'list',
		data: data.map(toJson),
		list_metadata: backwards
			? { before: more ? first : null, after: last }
			: { before: cursor ? first : null, after: more ? last : null },
	})
}

/** A list query whose `where` holds a `column = $n` filter for each query parameter present. */
function listQuery(c: Context, select: string, idColumn: string, filters: Record<string, string>): ListQuery {
	const query: ListQuery = { select, idColumn, where: [], params: [] }
	for (const [param, condition] of Object.entries(filters)) {
		const value = c.req.query(param)
		if (!value) continue
		query.params.push(value)
		query.where.push(condition.replace('?', `$${query.params.length}`))
	}
	return query
}

interface DomainData {
	domain: string
	state?: string
}

const domainData = (body: Body): DomainData[] | undefined =>
	Array.isArray(body.domain_data)
		? body.domain_data.filter((d): d is DomainData => typeof d === 'object' && d !== null && 'domain' in d)
		: undefined

const metadataJson = (body: Body) =>
	JSON.stringify(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {})

export function directoryRoutes(app: Hono, ctx: Ctx) {
	const { db, cfg } = ctx
	// Invitees are matched by email when they sign in, so the app itself is the accept link.
	const appOrigin = cfg.allowedRedirectUris[0] ? new URL(cfg.allowedRedirectUris[0]).origin : cfg.publicOrigin
	const invitation = (row: InvitationRow) => invitationJson(row, `${appOrigin}/`)

	const requireApiKey: MiddlewareHandler = async (c, next) => {
		const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
		if (!token || !safeEqual(token, cfg.apiKey)) return c.json({ message: 'Unauthorized' }, 401)
		await next()
	}
	for (const path of [
		'/user_management/users',
		'/user_management/users/*',
		'/user_management/organization_memberships',
		'/user_management/organization_memberships/*',
		'/user_management/invitations',
		'/user_management/invitations/*',
		'/organizations',
		'/organizations/*',
		'/organization_domains',
		'/organization_domains/*',
		'/api_keys/*',
		'/portal/*',
	]) {
		app.use(path, requireApiKey)
	}

	const getUser = (id: string | undefined) => one<UserRow>(db, 'SELECT * FROM users WHERE id = $1', [id ?? ''])
	const getOrg = (id: string | undefined) =>
		one<OrganizationRow>(db, 'SELECT * FROM organizations WHERE id = $1', [id ?? ''])
	const getMembership = (id: string) => oneOrThrow<MembershipRow>(db, `${MEMBERSHIP_SELECT} WHERE m.id = $1`, [id])
	const getInvitation = (id: string) => one<InvitationRow>(db, 'SELECT * FROM invitations WHERE id = $1', [id])
	const orgJson = async (org: OrganizationRow) =>
		organizationJson(
			org,
			await db.query<DomainRow>('SELECT * FROM organization_domains WHERE organization_id = $1 ORDER BY id', [
				org.id,
			]),
		)
	const insertDomains = async (orgId: string, domains: DomainData[]) => {
		for (const domain of domains) {
			await db.query(
				'INSERT INTO organization_domains (id, organization_id, domain, state) VALUES ($1, $2, $3, $4)',
				[newId('org_domain'), orgId, domain.domain, domain.state ?? 'pending'],
			)
		}
	}

	// --- Users ---

	app.get('/user_management/users', (c) =>
		paginate(
			c,
			db,
			listQuery(c, 'SELECT u.* FROM users u', 'u.id', {
				email: 'lower(u.email) = lower(?)',
				organization_id:
					'EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id AND m.organization_id = ?)',
			}),
			userJson,
		),
	)

	app.get('/user_management/users/:id', async (c) => {
		const user = await getUser(c.req.param('id'))
		return user ? c.json(userJson(user)) : notFound(c, 'User', c.req.param('id'))
	})

	// --- Organizations ---

	app.post('/organizations', async (c) => {
		const body = await readBody(c)
		const name = str(body.name)
		if (!name) return apiError(c, 422, 'invalid_request_parameters', 'name is required')
		const org = await oneOrThrow<OrganizationRow>(
			db,
			'INSERT INTO organizations (id, name, external_id, metadata) VALUES ($1, $2, $3, $4::text::jsonb) RETURNING *',
			[newId('org'), name, str(body.external_id) ?? null, metadataJson(body)],
		)
		await insertDomains(org.id, domainData(body) ?? [])
		return c.json(await orgJson(org), 201)
	})

	app.get('/organizations/:id', async (c) => {
		const org = await getOrg(c.req.param('id'))
		return org ? c.json(await orgJson(org)) : notFound(c, 'Organization', c.req.param('id'))
	})

	app.put('/organizations/:id', async (c) => {
		const id = c.req.param('id')
		if (!(await getOrg(id))) return notFound(c, 'Organization', id)
		const body = await readBody(c)
		// Metadata keys merge; a null value deletes the key (WorkOS semantics).
		const org = await oneOrThrow<OrganizationRow>(
			db,
			`UPDATE organizations SET
				name = coalesce($2, name),
				external_id = coalesce($3, external_id),
				stripe_customer_id = coalesce($4, stripe_customer_id),
				metadata = jsonb_strip_nulls(metadata || $5::text::jsonb),
				updated_at = now()
			WHERE id = $1 RETURNING *`,
			[
				id,
				str(body.name) ?? null,
				str(body.external_id) ?? null,
				str(body.stripe_customer_id) ?? null,
				metadataJson(body),
			],
		)
		const domains = domainData(body)
		if (domains) {
			await db.query('DELETE FROM organization_domains WHERE organization_id = $1', [id])
			await insertDomains(id, domains)
		}
		return c.json(await orgJson(org))
	})

	// Domains are trusted admin input with no verification path here, so they are created verified.
	app.post('/organization_domains', async (c) => {
		const body = await readBody(c)
		const orgId = str(body.organization_id)
		const domain = str(body.domain)
		if (!domain) return apiError(c, 422, 'invalid_request_parameters', 'domain is required')
		if (!(await getOrg(orgId))) return notFound(c, 'Organization', orgId ?? '')
		if (await one(db, 'SELECT 1 FROM organization_domains WHERE lower(domain) = lower($1)', [domain])) {
			return apiError(c, 409, 'domain_already_exists', `Domain ${domain} is already in use.`)
		}
		const row = await oneOrThrow<DomainRow>(
			db,
			`INSERT INTO organization_domains (id, organization_id, domain, state) VALUES ($1, $2, $3, 'verified') RETURNING *`,
			[newId('org_domain'), orgId, domain],
		)
		return c.json(domainJson(row), 201)
	})

	app.delete('/organization_domains/:id', async (c) => {
		const deleted = await one(db, 'DELETE FROM organization_domains WHERE id = $1 RETURNING id', [
			c.req.param('id'),
		])
		return deleted ? c.body(null, 204) : notFound(c, 'Organization domain', c.req.param('id'))
	})

	app.post('/portal/generate_link', (c) =>
		apiError(c, 501, 'not_implemented', 'The WorkOS admin portal is not available on this self-hosted deployment.'),
	)

	// --- Organization memberships ---

	app.get('/user_management/organization_memberships', async (c) => {
		const { user_id: userId, organization_id: orgId, statuses } = c.req.query()
		if (!userId && !orgId) {
			return apiError(c, 422, 'invalid_request_parameters', 'user_id or organization_id is required')
		}
		const query = listQuery(c, MEMBERSHIP_SELECT, 'm.id', {
			user_id: 'm.user_id = ?',
			organization_id: 'm.organization_id = ?',
		})
		// Like WorkOS, only active memberships unless `statuses` says otherwise.
		const wanted = (statuses || 'active').split(',')
		query.where.push(`m.status IN (${wanted.map((_, i) => `$${query.params.length + i + 1}`).join(', ')})`)
		query.params.push(...wanted)
		return paginate(c, db, query, membershipJson)
	})

	app.get('/user_management/organization_memberships/:id', async (c) => {
		const membership = await one<MembershipRow>(db, `${MEMBERSHIP_SELECT} WHERE m.id = $1`, [c.req.param('id')])
		return membership
			? c.json(membershipJson(membership))
			: notFound(c, 'Organization membership', c.req.param('id'))
	})

	app.post('/user_management/organization_memberships', async (c) => {
		const body = await readBody(c)
		const user = await getUser(str(body.user_id))
		if (!user) return notFound(c, 'User', str(body.user_id) ?? '')
		const org = await getOrg(str(body.organization_id))
		if (!org) return notFound(c, 'Organization', str(body.organization_id) ?? '')
		const id = await upsertMembership(db, user.id, org.id, str(body.role_slug) ?? 'member')
		return c.json(membershipJson(await getMembership(id)), 201)
	})

	app.put('/user_management/organization_memberships/:id', async (c) => {
		const body = await readBody(c)
		const roleSlug = str(body.role_slug) ?? (Array.isArray(body.role_slugs) ? str(body.role_slugs[0]) : undefined)
		if (!roleSlug) return apiError(c, 422, 'invalid_request_parameters', 'role_slug is required')
		const updated = await one<{ id: string }>(
			db,
			'UPDATE organization_memberships SET role_slug = $2, updated_at = now() WHERE id = $1 RETURNING id',
			[c.req.param('id'), roleSlug],
		)
		if (!updated) return notFound(c, 'Organization membership', c.req.param('id'))
		return c.json(membershipJson(await getMembership(updated.id)))
	})

	app.delete('/user_management/organization_memberships/:id', async (c) => {
		const deleted = await one(db, 'DELETE FROM organization_memberships WHERE id = $1 RETURNING id', [
			c.req.param('id'),
		])
		return deleted ? c.body(null, 204) : notFound(c, 'Organization membership', c.req.param('id'))
	})

	for (const [action, status] of [
		['deactivate', 'inactive'],
		['reactivate', 'active'],
	] as const) {
		app.put(`/user_management/organization_memberships/:id/${action}`, async (c) => {
			const updated = await one<{ id: string }>(
				db,
				'UPDATE organization_memberships SET status = $2, updated_at = now() WHERE id = $1 RETURNING id',
				[c.req.param('id'), status],
			)
			if (!updated) return notFound(c, 'Organization membership', c.req.param('id'))
			return c.json(membershipJson(await getMembership(updated.id)))
		})
	}

	// --- Invitations (no email is sent; pending invitations are accepted when the invitee signs in) ---

	app.get('/user_management/invitations', (c) =>
		paginate(
			c,
			db,
			listQuery(c, 'SELECT i.* FROM invitations i', 'i.id', {
				email: 'lower(i.email) = lower(?)',
				organization_id: 'i.organization_id = ?',
			}),
			invitation,
		),
	)

	app.get('/user_management/invitations/by_token/:token', async (c) => {
		const row = await one<InvitationRow>(db, 'SELECT * FROM invitations WHERE token = $1', [c.req.param('token')])
		return row ? c.json(invitation(row)) : notFound(c, 'Invitation', c.req.param('token'))
	})

	app.get('/user_management/invitations/:id', async (c) => {
		const row = await getInvitation(c.req.param('id'))
		return row ? c.json(invitation(row)) : notFound(c, 'Invitation', c.req.param('id'))
	})

	// Error messages match the WorkOS ones the API inspects ("already a member", "already invited").
	app.post('/user_management/invitations', async (c) => {
		const body = await readBody(c)
		const email = str(body.email)?.toLowerCase()
		if (!email?.includes('@')) return apiError(c, 422, 'invalid_request_parameters', 'A valid email is required')
		const orgId = str(body.organization_id) ?? null
		if (orgId) {
			if (!(await getOrg(orgId))) return notFound(c, 'Organization', orgId)
			const member = await one<{ id: string }>(db, 'SELECT id FROM users WHERE email = $1', [email])
			if (member && (await isActiveMember(db, member.id, orgId))) {
				return apiError(c, 400, 'user_already_organization_member', 'User already a member of organization.')
			}
			const invited = await one(
				db,
				`SELECT 1 FROM invitations WHERE lower(email) = $1 AND organization_id = $2 AND state = 'pending' AND expires_at > now()`,
				[email, orgId],
			)
			if (invited)
				return apiError(
					c,
					400,
					'email_already_invited_to_organization',
					'Email already invited to organization.',
				)
		}
		const days = Math.min(Math.max(Number(body.expires_in_days) || 7, 1), 30)
		const row = await oneOrThrow<InvitationRow>(
			db,
			`INSERT INTO invitations (id, email, organization_id, inviter_user_id, role_slug, token, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING *`,
			[
				newId('invitation'),
				email,
				orgId,
				str(body.inviter_user_id) ?? null,
				str(body.role_slug) ?? null,
				randomToken(24),
				days,
			],
		)
		return c.json(invitation(row), 201)
	})

	app.post('/user_management/invitations/:id/revoke', async (c) => {
		const row = await getInvitation(c.req.param('id'))
		if (!row) return notFound(c, 'Invitation', c.req.param('id'))
		if (invitationState(row) !== 'pending') {
			return apiError(c, 400, 'invite_not_pending', 'Only pending invitations can be revoked.')
		}
		const revoked = await oneOrThrow<InvitationRow>(
			db,
			`UPDATE invitations SET state = 'revoked', revoked_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
			[row.id],
		)
		return c.json(invitation(revoked))
	})

	app.post('/user_management/invitations/:id/accept', async (c) => {
		const row = await getInvitation(c.req.param('id'))
		if (!row) return notFound(c, 'Invitation', c.req.param('id'))
		if (invitationState(row) !== 'pending') {
			return apiError(c, 400, 'invite_not_pending', 'Only pending invitations can be accepted.')
		}
		const user = await one<{ id: string }>(db, 'SELECT id FROM users WHERE lower(email) = lower($1)', [row.email])
		if (!user) return notFound(c, 'User', row.email)
		await acceptInvitation(db, row, user.id)
		return c.json(
			invitation(await oneOrThrow<InvitationRow>(db, 'SELECT * FROM invitations WHERE id = $1', [row.id])),
		)
	})

	// --- User API keys (personal access tokens) ---

	app.post('/user_management/users/:id/api_keys', async (c) => {
		const userId = c.req.param('id')
		const body = await readBody(c)
		const orgId = str(body.organization_id)
		if (!(await getUser(userId))) return notFound(c, 'User', userId)
		if (!orgId || !(await isActiveMember(db, userId, orgId))) {
			return apiError(
				c,
				422,
				'invalid_request_parameters',
				'The user must have an active membership in organization_id.',
			)
		}
		const value = `sk_${randomToken(30)}`
		const row = await oneOrThrow<ApiKeyRow>(
			db,
			`INSERT INTO api_keys (id, user_id, organization_id, name, value_hash, obfuscated_value, permissions, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8) RETURNING *`,
			[
				newId('api_key'),
				userId,
				orgId,
				str(body.name) ?? 'API key',
				sha256(value),
				`sk_...${value.slice(-4)}`,
				JSON.stringify(Array.isArray(body.permissions) ? body.permissions : []),
				str(body.expires_at) ?? null,
			],
		)
		return c.json({ ...apiKeyJson(row), value }, 201)
	})

	app.get('/user_management/users/:id/api_keys', async (c) => {
		const query = listQuery(c, 'SELECT k.* FROM api_keys k', 'k.id', { organization_id: 'k.organization_id = ?' })
		query.params.push(c.req.param('id'))
		query.where.push(`k.user_id = $${query.params.length}`)
		return paginate(c, db, query, apiKeyJson)
	})

	app.delete('/api_keys/:id', async (c) => {
		const deleted = await one(db, 'DELETE FROM api_keys WHERE id = $1 RETURNING id', [c.req.param('id')])
		return deleted ? c.body(null, 204) : notFound(c, 'API key', c.req.param('id'))
	})

	// A key stops validating once it expires or its owner is no longer an active member of the key's org.
	app.post('/api_keys/validations', async (c) => {
		const body = await readBody(c)
		const row = await one<ApiKeyRow>(
			db,
			`UPDATE api_keys k SET last_used_at = now()
			FROM organization_memberships m
			WHERE k.value_hash = $1 AND (k.expires_at IS NULL OR k.expires_at > now())
				AND m.user_id = k.user_id AND m.organization_id = k.organization_id AND m.status = 'active'
			RETURNING k.*`,
			[sha256(str(body.value) ?? '')],
		)
		return c.json({ api_key: row ? apiKeyJson(row) : null })
	})
}
