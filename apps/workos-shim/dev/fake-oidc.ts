// A stand-in OIDC provider (Keycloak-like) for local development and tests.
// `bun dev/fake-oidc.ts` serves it on FAKE_OIDC_PORT (8721); /auth shows a form where you type any email.
// Client secret: FAKE_OIDC_CLIENT_SECRET (default 'dev-secret'). Issuer: http://127.0.0.1:<port>/realms/dev.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { html, page, str } from '../src/http'
import { sha256 } from '../src/ids'

export interface FakeUser {
	sub: string
	email: string
	email_verified?: boolean
	given_name?: string
	family_name?: string
	groups?: string[]
}

interface Grant {
	user: FakeUser
	nonce: string
	challenge: string
	clientId: string
}

/** `state.nextUser`, when set, signs in immediately at /auth (for tests); otherwise /auth shows a form. */
export async function fakeOidcApp(realm: string, clientSecret: string) {
	const { privateKey, publicKey } = await generateKeyPair('RS256')
	// A fresh kid per start, so relying parties refetch the JWKS after a restart.
	const kid = crypto.randomUUID()
	const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
	const codes = new Map<string, Grant>()
	const state: { nextUser: FakeUser | undefined; clientSecret: string } = { nextUser: undefined, clientSecret }

	const issue = (redirectUri: string, oauthState: string, grant: Grant) => {
		const code = crypto.randomUUID()
		codes.set(code, grant)
		const url = new URL(redirectUri)
		url.searchParams.set('code', code)
		url.searchParams.set('state', oauthState)
		return url.toString()
	}

	const app = new Hono().basePath(`/realms/${realm}`)
	const issuerOf = (url: string) => `${new URL(url).origin}/realms/${realm}`
	app.get('/.well-known/openid-configuration', (c) => {
		const issuer = issuerOf(c.req.url)
		return c.json({
			issuer,
			authorization_endpoint: `${issuer}/auth`,
			token_endpoint: `${issuer}/token`,
			jwks_uri: `${issuer}/certs`,
			end_session_endpoint: `${issuer}/logout`,
		})
	})
	app.get('/certs', (c) => c.json({ keys: [jwk] }))
	app.get('/auth', (c) => {
		const q = c.req.query()
		if (q.code_challenge_method !== 'S256' || !q.redirect_uri) return c.text('bad request', 400)
		const grant = { nonce: q.nonce ?? '', challenge: q.code_challenge ?? '', clientId: q.client_id ?? '' }
		if (state.nextUser) return c.redirect(issue(q.redirect_uri, q.state ?? '', { ...grant, user: state.nextUser }))
		return page(
			c,
			'Fake IdP sign-in',
			html`<form method="post" action="auth">
				<input type="hidden" name="query" value="${new URL(c.req.url).search}" />
				<p>
					<input
						name="email"
						type="email"
						value="${q.login_hint ?? ''}"
						placeholder="you@neara.com"
						required
					/>
				</p>
				<p>
					<label><input name="email_verified" type="checkbox" checked /> email verified</label>
				</p>
				<p><button type="submit">Sign in</button></p>
			</form>`,
		)
	})
	app.post('/auth', async (c) => {
		const form = await c.req.parseBody()
		const q = Object.fromEntries(new URLSearchParams(str(form.query) ?? ''))
		const email = str(form.email) ?? ''
		const [name = ''] = email.split('@')
		const user: FakeUser = {
			sub: `fake-${email}`,
			email,
			email_verified: form.email_verified === 'on',
			given_name: name,
		}
		const grant = { user, nonce: q.nonce ?? '', challenge: q.code_challenge ?? '', clientId: q.client_id ?? '' }
		return c.redirect(issue(q.redirect_uri ?? '', q.state ?? '', grant))
	})
	app.post('/token', async (c) => {
		const body = Object.fromEntries(new URLSearchParams(await c.req.text()))
		const grant = codes.get(body.code ?? '')
		codes.delete(body.code ?? '')
		if (
			!grant ||
			body.client_secret !== state.clientSecret ||
			sha256(body.code_verifier ?? '') !== grant.challenge
		) {
			return c.json({ error: 'invalid_grant' }, 400)
		}
		const idToken = await new SignJWT({ email_verified: true, ...grant.user, nonce: grant.nonce })
			.setProtectedHeader({ alg: 'RS256', kid })
			.setIssuer(issuerOf(c.req.url))
			.setAudience(grant.clientId)
			.setSubject(grant.user.sub)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey)
		return c.json({ access_token: 'unused', token_type: 'Bearer', id_token: idToken })
	})
	app.get('/logout', (c) => c.text('logged out'))
	return { app, state }
}

if (import.meta.main) {
	const port = Number(process.env.FAKE_OIDC_PORT ?? 8721)
	const { app } = await fakeOidcApp('dev', process.env.FAKE_OIDC_CLIENT_SECRET ?? 'dev-secret')
	serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
	console.log(`fake OIDC issuer http://127.0.0.1:${port}/realms/dev`)
}
