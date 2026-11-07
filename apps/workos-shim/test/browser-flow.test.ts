import { parseWorkOsAccessTokenClaims } from '@humanlayer/schemas/effect/workos-access-token'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { seed } from '../src/cli'
import type { Db } from '../src/db'
import {
	APP_ORIGIN,
	authenticate,
	browserLogin,
	CLIENT_ID,
	type FakeOidc,
	get,
	location,
	REDIRECT_URI,
	riptideDb,
	type Shim,
	startFakeOidc,
	startShim,
	verifyLikeRiptide,
} from './helpers'

interface AuthKitHttpClient {
	authenticateWithCode(input: { code: string; codeVerifier: string; useCookie: boolean }): Promise<any>
	authenticateWithRefreshToken(input: {
		refreshToken: string
		organizationId?: string
		useCookie: boolean
	}): Promise<any>
	getLogoutUrl(input: { sessionId: string; returnTo: string }): URL
}

// authkit-js does not export HttpClient; load the source module the browser bundle is built from.
const authkitHttpClientModule = '@workos-inc/authkit-js/src/http-client'

let oidc: FakeOidc
let shim: Shim
let riptide: Db
let defaultOrg: { orgId: string; internalOrgId: string }
let authkit: AuthKitHttpClient

beforeAll(async () => {
	oidc = await startFakeOidc()
	shim = await startShim(oidc)
	riptide = await riptideDb()
	defaultOrg = await seed(shim.db, riptide, 'Neara')
	shim.cfg.defaultOrgId = defaultOrg.orgId
	const { HttpClient } = (await import(authkitHttpClientModule)) as {
		HttpClient: new (options: {
			clientId: string
			hostname: string
			port: number
			https: boolean
		}) => AuthKitHttpClient
	}
	authkit = new HttpClient({ clientId: CLIENT_ID, hostname: '127.0.0.1', port: shim.port, https: false })
})

afterAll(async () => {
	await shim.close()
	await riptide.close()
	await oidc.close()
})

describe('browser AuthKit flow', () => {
	it('signs in with PKCE, refreshes, switches org and signs out', async () => {
		const login = await browserLogin(shim, oidc, {
			sub: 'kc-admin',
			email: 'Admin@neara.com',
			given_name: 'Ada',
			family_name: 'Admin',
		})
		expect(login.back?.origin + (login.back?.pathname ?? '')).toBe(REDIRECT_URI)
		expect(login.state).toBe('app-state')

		const auth = await authkit.authenticateWithCode({
			code: login.code ?? '',
			codeVerifier: login.verifier,
			useCookie: false,
		})
		expect(auth.user).toMatchObject({
			object: 'user',
			email: 'admin@neara.com',
			firstName: 'Ada',
			lastName: 'Admin',
			emailVerified: true,
		})
		expect(auth.user.id).toMatch(/^user_[0-9A-Z]{26}$/)
		expect(auth.organizationId).toBe(defaultOrg.orgId)
		expect(auth.authenticationMethod).toBe('SSO')

		const { payload, protectedHeader } = await verifyLikeRiptide(shim, auth.accessToken)
		expect(protectedHeader.kid).toBeTruthy()
		const claims = parseWorkOsAccessTokenClaims(payload)
		expect(claims).toMatchObject({
			iss: shim.origin,
			sub: auth.user.id,
			org_id: defaultOrg.orgId,
			internal_org_id: defaultOrg.internalOrgId,
			role: 'admin',
			roles: ['admin'],
			permissions: [],
		})
		expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600)

		// The code is single use.
		expect(
			(
				await authenticate(shim, {
					grant_type: 'authorization_code',
					code: login.code ?? '',
					code_verifier: login.verifier,
				})
			).json.error,
		).toBe('invalid_grant')

		const refreshed = await authkit.authenticateWithRefreshToken({
			refreshToken: auth.refreshToken,
			useCookie: false,
		})
		expect(refreshed.refreshToken).not.toBe(auth.refreshToken)
		const reused = await authenticate(shim, { grant_type: 'refresh_token', refresh_token: auth.refreshToken })
		expect(reused).toMatchObject({ status: 400, json: { error: 'invalid_grant' } })

		// Org switch: allowed for an active membership, refused otherwise (without burning the refresh token).
		const other = await seed(shim.db, riptide, 'Other')
		const notMember = await authenticate(shim, {
			grant_type: 'refresh_token',
			refresh_token: refreshed.refreshToken,
			organization_id: other.orgId,
		})
		expect(notMember.status).toBe(400)
		await shim.db.query(
			`INSERT INTO organization_memberships (id, user_id, organization_id, role_slug, status) VALUES ('om_x', $1, $2, 'member', 'active')`,
			[auth.user.id, other.orgId],
		)
		const switched = await authkit.authenticateWithRefreshToken({
			refreshToken: refreshed.refreshToken,
			organizationId: other.orgId,
			useCookie: false,
		})
		expect(switched.organizationId).toBe(other.orgId)
		const switchedClaims = (await verifyLikeRiptide(shim, switched.accessToken)).payload
		expect(switchedClaims).toMatchObject({
			org_id: other.orgId,
			internal_org_id: other.internalOrgId,
			role: 'member',
		})

		// Logout revokes the shim session only and goes straight back to the app.
		const logoutUrl = authkit.getLogoutUrl({ sessionId: String(switchedClaims.sid), returnTo: `${APP_ORIGIN}/` })
		expect(location(await get(logoutUrl.toString()))).toBe(`${APP_ORIGIN}/`)
		const afterLogout = await authenticate(shim, {
			grant_type: 'refresh_token',
			refresh_token: switched.refreshToken,
		})
		expect(afterLogout.json.error).toBe('invalid_grant')
	})

	it('falls back to the shim origin for a return_to that is not allowed', async () => {
		const res = await get(
			`${shim.origin}/user_management/sessions/logout?session_id=x&return_to=${encodeURIComponent('https://evil.test/')}`,
		)
		expect(location(res)).toBe(`${shim.origin}/`)
	})

	it('ends the Keycloak session too with SHIM_OIDC_LOGOUT=true', async () => {
		const login = await browserLogin(shim, oidc, { sub: 'kc-member', email: 'member@neara.com' })
		const auth = await authenticate(shim, {
			grant_type: 'authorization_code',
			code: login.code ?? '',
			code_verifier: login.verifier,
		})
		const { sid } = (await verifyLikeRiptide(shim, auth.json.access_token)).payload
		shim.cfg.oidcLogout = true
		try {
			const logoutUrl = authkit.getLogoutUrl({ sessionId: String(sid), returnTo: `${APP_ORIGIN}/` })
			const toIdp = new URL(location(await get(logoutUrl.toString())))
			expect(toIdp.origin + toIdp.pathname).toBe(`${oidc.issuer}/logout`)
			expect(toIdp.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_ORIGIN}/`)
			expect(toIdp.searchParams.get('id_token_hint')).toBeTruthy()
		} finally {
			shim.cfg.oidcLogout = false
		}
	})

	it('gives a plain member the member role', async () => {
		const login = await browserLogin(shim, oidc, { sub: 'kc-member', email: 'member@neara.com' })
		const auth = await authenticate(shim, {
			grant_type: 'authorization_code',
			code: login.code ?? '',
			code_verifier: login.verifier,
		})
		expect((await verifyLikeRiptide(shim, auth.json.access_token)).payload).toMatchObject({
			role: 'member',
			org_id: defaultOrg.orgId,
		})
	})

	it('rejects a wrong code_verifier', async () => {
		const login = await browserLogin(shim, oidc, { sub: 'kc-member', email: 'member@neara.com' })
		const res = await authenticate(shim, {
			grant_type: 'authorization_code',
			code: login.code ?? '',
			code_verifier: 'wrong',
		})
		expect(res).toMatchObject({ status: 400, json: { error: 'invalid_grant' } })
	})

	it('refuses other email domains and unverified emails', async () => {
		expect((await browserLogin(shim, oidc, { sub: 'kc-out', email: 'eve@example.com' })).callback.status).toBe(403)
		expect(
			(await browserLogin(shim, oidc, { sub: 'kc-unv', email: 'bob@neara.com', email_verified: false })).callback
				.status,
		).toBe(403)
	})

	it('refuses redirect URIs that are not allowed', async () => {
		const res = await get(
			`${shim.origin}/user_management/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent('https://evil.test/cb')}&response_type=code`,
		)
		expect(res.status).toBe(400)
	})

	it('answers the CORS preflight AuthKit sends before a JSON POST', async () => {
		const res = await fetch(`${shim.origin}/user_management/authenticate`, {
			method: 'OPTIONS',
			headers: {
				origin: APP_ORIGIN,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		})
		expect(res.status).toBe(204)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
	})
})
