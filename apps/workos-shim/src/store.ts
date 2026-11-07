import type { Config } from './config'
import { type Db, one, oneOrThrow } from './db'
import { newId, randomToken, sha256 } from './ids'
import { type AccessTokenClaims, currentSigningKey, signAccessToken } from './keys'
import type { IdTokenClaims, Oidc } from './oidc'
import type { InvitationRow, MembershipRow, UserRow } from './rows'
import { userJson } from './serialize'

export interface Ctx {
	db: Db
	cfg: Config
	/** Unset in tailscale mode. */
	oidc: Oidc | undefined
}

export class LoginRejected extends Error {}

/** Who signed in, from the IdP's id_token or from Tailscale's identity headers. */
export interface Identity {
	/** IdP subject; null for Tailscale, whose users are matched by email. */
	sub: string | null
	email: string
	emailVerified: boolean
	firstName: string | null
	lastName: string | null
	picture: string | null
	groups: string[]
}

export const identityFromOidc = (claims: IdTokenClaims): Identity => ({
	sub: claims.sub,
	email: claims.email ?? '',
	emailVerified: claims.email_verified === true,
	firstName: claims.given_name ?? null,
	lastName: claims.family_name ?? null,
	picture: claims.picture ?? null,
	groups: claims.groups ?? [],
})

/**
 * Applies the verified-email / domain / group policy and returns the shim user.
 * Users are found by sub, then by email, so a Keycloak login takes over a user first made through Tailscale.
 */
export async function upsertUser(ctx: Ctx, identity: Identity): Promise<UserRow> {
	const { db, cfg } = ctx
	const email = identity.email.toLowerCase()
	if (!email || !identity.emailVerified) throw new LoginRejected('A verified email address is required.')
	const domain = email.split('@')[1] ?? ''
	if (cfg.allowedEmailDomains.length > 0 && !cfg.allowedEmailDomains.includes(domain)) {
		throw new LoginRejected(`Accounts from ${domain} are not allowed.`)
	}
	if (cfg.requiredGroup) {
		// Keycloak sends full group paths ("/team") when "Full group path" is on.
		const wanted = cfg.requiredGroup.replace(/^\//, '')
		if (!identity.groups.some((group) => group.replace(/^\//, '') === wanted)) {
			throw new LoginRejected(`You must be in the ${cfg.requiredGroup} group.`)
		}
	}

	const profile = [email, identity.firstName, identity.lastName, identity.picture]
	const existing =
		(identity.sub
			? await one<{ id: string }>(db, 'SELECT id FROM users WHERE oidc_sub = $1', [identity.sub])
			: undefined) ?? (await one<{ id: string }>(db, 'SELECT id FROM users WHERE email = $1', [email]))
	if (existing) {
		return oneOrThrow<UserRow>(
			db,
			`UPDATE users SET oidc_sub = coalesce($2, oidc_sub), email = $3, email_verified = true, first_name = $4,
				last_name = $5, profile_picture_url = $6, last_sign_in_at = now(), updated_at = now()
			WHERE id = $1 RETURNING *`,
			[existing.id, identity.sub, ...profile],
		)
	}
	return oneOrThrow<UserRow>(
		db,
		`INSERT INTO users (id, oidc_sub, email, email_verified, first_name, last_name, profile_picture_url, last_sign_in_at)
		VALUES ($1, $2, $3, true, $4, $5, $6, now()) RETURNING *`,
		[newId('user'), identity.sub, ...profile],
	)
}

/** Creates an active membership, or reactivates an existing one with the given role. Returns its id. */
export async function upsertMembership(
	db: Db,
	userId: string,
	organizationId: string,
	roleSlug: string,
): Promise<string> {
	const row = await oneOrThrow<{ id: string }>(
		db,
		`INSERT INTO organization_memberships (id, user_id, organization_id, role_slug, status)
		VALUES ($1, $2, $3, $4, 'active')
		ON CONFLICT (user_id, organization_id)
		DO UPDATE SET role_slug = EXCLUDED.role_slug, status = 'active', updated_at = now()
		RETURNING id`,
		[newId('om'), userId, organizationId, roleSlug],
	)
	return row.id
}

export async function acceptInvitation(db: Db, invitation: InvitationRow, userId: string): Promise<void> {
	if (invitation.organization_id) {
		await upsertMembership(db, userId, invitation.organization_id, invitation.role_slug ?? 'member')
	}
	await db.query(
		`UPDATE invitations SET state = 'accepted', accepted_at = now(), accepted_user_id = $2, updated_at = now() WHERE id = $1`,
		[invitation.id, userId],
	)
}

/** Login side effects: accept pending invitations for the email, join the default org, apply SHIM_ADMIN_EMAILS. */
export async function onLogin(ctx: Ctx, user: UserRow): Promise<void> {
	const { db, cfg } = ctx
	const invitations = await db.query<InvitationRow>(
		`SELECT * FROM invitations WHERE lower(email) = $1 AND state = 'pending' AND expires_at > now()`,
		[user.email],
	)
	for (const invitation of invitations) await acceptInvitation(db, invitation, user.id)

	if (!cfg.defaultOrgId) return
	const isAdmin = cfg.adminEmails.includes(user.email)
	const membership = await one<MembershipRow>(
		db,
		'SELECT * FROM organization_memberships WHERE user_id = $1 AND organization_id = $2',
		[user.id, cfg.defaultOrgId],
	)
	if (!membership) {
		await upsertMembership(db, user.id, cfg.defaultOrgId, isAdmin ? 'admin' : 'member')
	} else if (isAdmin && membership.role_slug !== 'admin') {
		await db.query(`UPDATE organization_memberships SET role_slug = 'admin', updated_at = now() WHERE id = $1`, [
			membership.id,
		])
	}
}

export async function isActiveMember(db: Db, userId: string, organizationId: string): Promise<boolean> {
	const row = await one(
		db,
		`SELECT 1 FROM organization_memberships WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
		[userId, organizationId],
	)
	return row !== undefined
}

/** The preferred org if the user is an active member, else the default org, else the oldest active membership. */
export async function pickOrganization(ctx: Ctx, userId: string, preferred: string | null): Promise<string | null> {
	for (const orgId of [preferred, ctx.cfg.defaultOrgId]) {
		if (orgId && (await isActiveMember(ctx.db, userId, orgId))) return orgId
	}
	const first = await one<{ organization_id: string }>(
		ctx.db,
		`SELECT organization_id FROM organization_memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at, id LIMIT 1`,
		[userId],
	)
	return first?.organization_id ?? null
}

export async function createSession(
	ctx: Ctx,
	userId: string,
	preferredOrg: string | null,
	idToken: string | null,
): Promise<string> {
	const session = await oneOrThrow<{ id: string }>(
		ctx.db,
		'INSERT INTO sessions (id, user_id, organization_id, oidc_id_token) VALUES ($1, $2, $3, $4) RETURNING id',
		[newId('session'), userId, await pickOrganization(ctx, userId, preferredOrg), idToken],
	)
	return session.id
}

/**
 * Mints an access token and a new refresh token for a session, as a WorkOS authenticate response.
 * Role and org are read fresh, so membership changes apply at the next refresh.
 */
export async function issueTokens(ctx: Ctx, sessionId: string) {
	const { db, cfg } = ctx
	const session = await oneOrThrow<{ user_id: string; organization_id: string | null }>(
		db,
		'SELECT user_id, organization_id FROM sessions WHERE id = $1',
		[sessionId],
	)
	const user = await oneOrThrow<UserRow>(db, 'SELECT * FROM users WHERE id = $1', [session.user_id])
	const orgId = await pickOrganization(ctx, user.id, session.organization_id)
	if (orgId !== session.organization_id) {
		await db.query('UPDATE sessions SET organization_id = $2 WHERE id = $1', [sessionId, orgId])
	}

	const claims: AccessTokenClaims = { sub: user.id, sid: sessionId }
	if (orgId) {
		const membership = await oneOrThrow<{ role_slug: string; metadata: Record<string, string> }>(
			db,
			`SELECT m.role_slug, o.metadata FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
			WHERE m.user_id = $1 AND m.organization_id = $2`,
			[user.id, orgId],
		)
		claims.org_id = orgId
		claims.role = membership.role_slug
		claims.internal_org_id = membership.metadata.internal_org_id
	}

	const refreshToken = randomToken()
	await db.query('INSERT INTO refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [
		sha256(refreshToken),
		sessionId,
	])
	return {
		user: userJson(user),
		organization_id: orgId ?? undefined,
		access_token: await signAccessToken(
			await currentSigningKey(db),
			cfg.publicOrigin,
			cfg.accessTokenTtlSeconds,
			claims,
		),
		refresh_token: refreshToken,
		authentication_method: 'SSO',
	}
}

export async function cleanupExpired(db: Db): Promise<void> {
	await db.exec(`
		DELETE FROM pending_logins WHERE expires_at < now();
		DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day';
		DELETE FROM device_codes WHERE expires_at < now() - interval '1 day';
	`)
}
