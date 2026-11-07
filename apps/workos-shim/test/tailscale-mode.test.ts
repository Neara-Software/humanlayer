import { afterAll, beforeAll, expect, it } from 'vitest'

import { seed } from '../src/cli'
import type { Db } from '../src/db'
import { decodeRfc2047 } from '../src/tailscale'
import {
	APP_ORIGIN,
	authenticate,
	authkitClient,
	browserLogin,
	CLIENT_ID,
	get,
	location,
	pkce,
	REDIRECT_URI,
	riptideDb,
	type Shim,
	startFakeOidc,
	startShim,
	testDb,
	verifyLikeRiptide,
} from './helpers'

let db: Db
let riptide: Db
let shim: Shim
let orgId: string

// What `tailscale serve` adds for a request from a user-owned device.
const identity = (login: string, name = '') => ({
	'Tailscale-User-Login': login,
	'Tailscale-User-Name': name,
	'Tailscale-User-Profile-Pic': 'https://lh3.googleusercontent.test/pic',
})

beforeAll(async () => {
	db = await testDb()
	shim = await startShim(undefined, {}, db)
	riptide = await riptideDb()
	orgId = (await seed(db, riptide, 'Neara')).orgId
	shim.cfg.defaultOrgId = orgId
})

afterAll(async () => {
	await shim.close()
	await db.close()
	await riptide.close()
})

function authorizeUrl(challenge: string) {
	const url = new URL(`${shim.origin}/user_management/authorize`)
	url.search = new URLSearchParams({
		provider: 'authkit',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		state: 'app-state',
		code_challenge: challenge,
		code_challenge_method: 'S256',
	}).toString()
	return url.toString()
}

it('signs in from the Tailscale headers and redirects straight back to the app', async () => {
	const { verifier, challenge } = pkce()
	const res = await get(authorizeUrl(challenge), {
		headers: identity('Admin@neara.com', '=?utf-8?q?Ad=C3=A1_Lovelace?='),
	})
	const back = new URL(location(res))
	expect(back.origin + back.pathname).toBe(REDIRECT_URI)
	expect(back.searchParams.get('state')).toBe('app-state')

	const authkit = await authkitClient(shim)
	const auth = await authkit.authenticateWithCode({
		code: back.searchParams.get('code') ?? '',
		codeVerifier: verifier,
		useCookie: false,
	})
	expect(auth.user).toMatchObject({
		email: 'admin@neara.com',
		emailVerified: true,
		firstName: 'Adá',
		lastName: 'Lovelace',
		profilePictureUrl: 'https://lh3.googleusercontent.test/pic',
	})
	const { payload } = await verifyLikeRiptide(shim, auth.accessToken)
	expect(payload).toMatchObject({ sub: auth.user.id, org_id: orgId, role: 'admin' })

	const logout = authkit.getLogoutUrl({ sessionId: String(payload.sid), returnTo: `${APP_ORIGIN}/` })
	expect(location(await get(logout.toString()))).toBe(`${APP_ORIGIN}/`)
	expect(
		(await authenticate(shim, { grant_type: 'refresh_token', refresh_token: auth.refreshToken })).json.error,
	).toBe('invalid_grant')
})

it('refuses requests without Tailscale identity headers', async () => {
	const res = await get(authorizeUrl(pkce().challenge))
	expect(res.status).toBe(403)
	expect(await res.text()).toContain('HumanLayer signs you in with your Tailscale identity')
	expect((await get(`${shim.origin}/user_management/device`)).status).toBe(403)
})

it('refuses other email domains', async () => {
	expect((await get(authorizeUrl(pkce().challenge), { headers: identity('eve@example.com') })).status).toBe(403)
})

it('approves a device for the header identity without an IdP', async () => {
	const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
		fetch(`${shim.origin}${path}`, {
			method: 'POST',
			redirect: 'manual',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams(body),
		})
	const poll = async (deviceCode: string) =>
		(
			await post('/user_management/authenticate', {
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceCode,
				client_id: CLIENT_ID,
			})
		).json() as Promise<Record<string, any>>

	const codes = (await (await post('/user_management/authorize/device', { client_id: CLIENT_ID })).json()) as Record<
		string,
		any
	>
	const who = identity('member@neara.com', 'Mem Ber')
	const confirm = await get(codes.verification_uri_complete, { headers: who })
	const page = await confirm.text()
	expect(page).toContain('Signed in as member@neara.com via Tailscale.')
	const csrf = page.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
	const cookie = (confirm.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

	const approved = await post('/user_management/device', { user_code: codes.user_code, csrf }, { ...who, cookie })
	expect(approved.status).toBe(200)
	expect(await approved.text()).toContain('You can close this tab')
	const tokens = await poll(codes.device_code)
	expect(tokens.user).toMatchObject({ email: 'member@neara.com', first_name: 'Mem', last_name: 'Ber' })
})

it('lets a later Keycloak login with the same email take over the user', async () => {
	const { verifier, challenge } = pkce()
	const first = new URL(
		location(await get(authorizeUrl(challenge), { headers: identity('later@neara.com', 'Later') })),
	)
	const before = await authenticate(shim, {
		grant_type: 'authorization_code',
		code: first.searchParams.get('code') ?? '',
		code_verifier: verifier,
	})

	const oidc = await startFakeOidc()
	const oidcShim = await startShim(oidc, { SHIM_DEFAULT_ORG_ID: orgId }, db)
	try {
		const login = await browserLogin(oidcShim, oidc, { sub: 'kc-later', email: 'later@neara.com' })
		const after = await authenticate(oidcShim, {
			grant_type: 'authorization_code',
			code: login.code ?? '',
			code_verifier: login.verifier,
		})
		expect(after.json.user.id).toBe(before.json.user.id)
		expect(await db.query('SELECT oidc_sub FROM users WHERE id = $1', [after.json.user.id])).toEqual([
			{ oidc_sub: 'kc-later' },
		])
	} finally {
		await oidcShim.close()
		await oidc.close()
	}
})

it('decodes RFC 2047 display names', () => {
	expect(decodeRfc2047('Tom Birch')).toBe('Tom Birch')
	expect(decodeRfc2047('=?utf-8?q?Zo=C3=AB_Smith?=')).toBe('Zoë Smith')
	expect(decodeRfc2047('=?UTF-8?B?TcO8bGxlcg==?= =?utf-8?q?_Jr?=')).toBe('Müller Jr')
})
