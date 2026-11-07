import { afterAll, beforeAll, expect, it } from 'vitest'

import {
	CLIENT_ID,
	type FakeOidc,
	get,
	location,
	type Shim,
	startFakeOidc,
	startShim,
	verifyLikeRiptide,
} from './helpers'

let oidc: FakeOidc
let shim: Shim

beforeAll(async () => {
	oidc = await startFakeOidc()
	shim = await startShim(oidc)
})

afterAll(async () => {
	await shim.close()
	await oidc.close()
})

// Same request shape as apps/cli/src/auth/workos-device-auth.ts and packages/session-sdk-auth/src/login.ts.
const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
	fetch(`${shim.origin}${path}`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(body),
	})

const poll = async (deviceCode: string) => {
	const res = await form('/user_management/authenticate', {
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		device_code: deviceCode,
		client_id: CLIENT_ID,
	})
	return { status: res.status, json: (await res.json()) as Record<string, any> }
}

it('runs the RFC 8628 device flow through the confirm page and Keycloak login', async () => {
	const start = await form('/user_management/authorize/device', { client_id: CLIENT_ID })
	const codes = (await start.json()) as Record<string, any>
	expect(codes).toMatchObject({
		verification_uri: `${shim.origin}/user_management/device`,
		expires_in: 300,
		interval: 5,
	})
	expect(codes.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
	expect(codes.verification_uri_complete).toBe(`${codes.verification_uri}?user_code=${codes.user_code}`)

	expect((await poll(codes.device_code)).json.error).toBe('authorization_pending')
	expect((await poll(codes.device_code)).json.error).toBe('slow_down')

	const confirm = await get(codes.verification_uri_complete)
	const page = await confirm.text()
	expect(page).toContain(codes.user_code)
	const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
	const cookie = (confirm.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

	// Without the CSRF cookie the form does nothing.
	expect((await form('/user_management/device', { user_code: codes.user_code, csrf })).status).toBe(400)

	oidc.state.nextUser = { sub: 'kc-cli', email: 'cli@neara.com' }
	const submitted = await form(
		'/user_management/device',
		{ user_code: codes.user_code.toLowerCase(), csrf },
		{ cookie },
	)
	const callback = await get(location(await get(location(submitted))))
	expect(callback.status).toBe(200)
	expect(await callback.text()).toContain('You can close this tab')

	const done = await poll(codes.device_code)
	expect(done.status).toBe(200)
	expect(done.json.user.email).toBe('cli@neara.com')
	expect(typeof done.json.refresh_token).toBe('string')
	expect((await verifyLikeRiptide(shim, done.json.access_token)).payload.sub).toBe(done.json.user.id)

	expect((await poll(codes.device_code)).json.error).toBe('invalid_grant')
})

it('reports access_denied when the login is refused', async () => {
	const codes = (await (await form('/user_management/authorize/device', { client_id: CLIENT_ID })).json()) as Record<
		string,
		any
	>
	const confirm = await get(codes.verification_uri_complete)
	const csrf = (await confirm.text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''
	const cookie = (confirm.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
	oidc.state.nextUser = { sub: 'kc-outsider', email: 'eve@example.com' }
	const submitted = await form('/user_management/device', { user_code: codes.user_code, csrf }, { cookie })
	expect((await get(location(await get(location(submitted))))).status).toBe(403)
	expect((await poll(codes.device_code)).json.error).toBe('access_denied')
})
