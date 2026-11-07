import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'

import { one } from './db'
import { html, oauthError, page, readBody, safeEqual, str } from './http'
import { newId, randomToken, sha256 } from './ids'
import { jwks } from './keys'
import type { DeviceCodeRow, PendingLoginRow, UserRow } from './rows'
import {
	cleanupExpired,
	createSession,
	type Ctx,
	isActiveMember,
	issueTokens,
	LoginRejected,
	onLogin,
	upsertUserFromOidc,
} from './store'

const PENDING_LOGIN_TTL = "interval '10 minutes'"
const DEVICE_CODE_TTL_SECONDS = 300
const DEVICE_POLL_INTERVAL_SECONDS = 5
const REFRESH_IDLE_TIMEOUT = "interval '30 days'"
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const CSRF_COOKIE = 'workos_shim_csrf'

const normalizeUserCode = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, '')

function newUserCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	return Array.from(bytes, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('')
}

const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

export function authRoutes(app: Hono, ctx: Ctx) {
	const { db, cfg, oidc } = ctx
	const allowedOrigins = new Set(cfg.allowedRedirectUris.map((uri) => new URL(uri).origin))

	type LoginRequest = Partial<Omit<PendingLoginRow, 'state' | 'nonce' | 'code_verifier'>> & {
		kind: PendingLoginRow['kind']
		login_hint?: string
	}

	async function startLogin(c: Context, pending: LoginRequest) {
		await cleanupExpired(db)
		const state = randomToken()
		const nonce = randomToken()
		const codeVerifier = randomToken()
		await db.query(
			`INSERT INTO pending_logins (state, kind, nonce, code_verifier, client_redirect_uri, client_state, code_challenge,
				organization_id, device_code_id, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ${PENDING_LOGIN_TTL})`,
			[
				state,
				pending.kind,
				nonce,
				codeVerifier,
				pending.client_redirect_uri ?? null,
				pending.client_state ?? null,
				pending.code_challenge ?? null,
				pending.organization_id ?? null,
				pending.device_code_id ?? null,
			],
		)
		return c.redirect(
			await oidc.authorizationUrl({
				state,
				nonce,
				codeChallenge: sha256(codeVerifier),
				loginHint: pending.login_hint,
			}),
		)
	}

	// --- Browser flow (AuthKit) ---

	app.get('/user_management/authorize', async (c) => {
		const q = c.req.query()
		if (q.client_id !== cfg.clientId) return page(c, 'Sign-in error', html`<p>Unknown client_id.</p>`, 400)
		if (!q.redirect_uri || !cfg.allowedRedirectUris.includes(q.redirect_uri)) {
			return page(c, 'Sign-in error', html`<p>redirect_uri is not allowed: ${q.redirect_uri ?? ''}</p>`, 400)
		}
		if (q.response_type !== 'code' || (q.code_challenge && q.code_challenge_method !== 'S256')) {
			const url = new URL(q.redirect_uri)
			url.searchParams.set('error', 'invalid_request')
			url.searchParams.set(
				'error_description',
				'response_type must be code and code_challenge_method must be S256',
			)
			if (q.state) url.searchParams.set('state', q.state)
			return c.redirect(url.toString())
		}
		return startLogin(c, {
			kind: 'authorize',
			client_redirect_uri: q.redirect_uri,
			client_state: q.state,
			code_challenge: q.code_challenge,
			organization_id: q.organization_id,
			login_hint: q.login_hint,
		})
	})

	app.get('/user_management/callback', async (c) => {
		const q = c.req.query()
		const pending = q.state
			? await one<PendingLoginRow>(
					db,
					'DELETE FROM pending_logins WHERE state = $1 AND expires_at > now() RETURNING *',
					[q.state],
				)
			: undefined
		if (!pending)
			return page(c, 'Sign-in expired', '<p>This sign-in attempt has expired. Please start again.</p>', 400)

		const deny = async (message: string) => {
			if (pending.device_code_id) {
				await db.query(`UPDATE device_codes SET status = 'denied' WHERE id = $1 AND status = 'pending'`, [
					pending.device_code_id,
				])
			}
			return page(c, 'Access denied', html`<p>${message}</p>`, 403)
		}
		if (q.error || !q.code) return deny(q.error_description ?? q.error ?? 'Sign-in was cancelled.')

		let user: UserRow
		let idToken: string
		try {
			const result = await oidc.exchangeCode(q.code, pending.code_verifier, pending.nonce)
			idToken = result.idToken
			user = await upsertUserFromOidc(ctx, result.claims)
		} catch (error) {
			if (error instanceof LoginRejected) return deny(error.message)
			throw error
		}
		await onLogin(ctx, user)
		const sessionId = await createSession(ctx, user.id, pending.organization_id, idToken)

		if (pending.kind === 'device') {
			const approved = await one(
				db,
				`UPDATE device_codes SET status = 'approved', session_id = $2
				WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING id`,
				[pending.device_code_id, sessionId],
			)
			return approved
				? page(c, 'Signed in', html`<p>Signed in as ${user.email}. You can close this tab.</p>`)
				: page(c, 'Code expired', '<p>This device code has expired. Start the login again.</p>', 400)
		}

		const redirectUri = pending.client_redirect_uri
		if (!redirectUri) throw new Error('Pending authorize login has no redirect_uri')
		const code = randomToken()
		await db.query(
			`INSERT INTO auth_codes (code_hash, session_id, redirect_uri, code_challenge, expires_at)
			VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
			[sha256(code), sessionId, redirectUri, pending.code_challenge],
		)
		const url = new URL(redirectUri)
		url.searchParams.set('code', code)
		if (pending.client_state) url.searchParams.set('state', pending.client_state)
		return c.redirect(url.toString())
	})

	app.use('/user_management/authenticate', cors({ origin: '*', allowMethods: ['POST'], maxAge: 600 }))

	app.post('/user_management/authenticate', async (c) => {
		const body = await readBody(c)
		if (body.client_id !== cfg.clientId) return oauthError(c, 400, 'invalid_client', 'Unknown client_id.')
		const clientSecret = str(body.client_secret)
		const hasSecret = clientSecret !== undefined
		if (hasSecret && !safeEqual(clientSecret, cfg.apiKey)) {
			return oauthError(c, 401, 'invalid_client', 'Invalid client_secret.')
		}

		switch (body.grant_type) {
			case 'authorization_code': {
				const codeHash = sha256(str(body.code) ?? '')
				const row = await one<{ code_challenge: string | null }>(
					db,
					'SELECT * FROM auth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
					[codeHash],
				)
				if (!row) return oauthError(c, 400, 'invalid_grant', 'The code is invalid or expired.')
				const verifier = str(body.code_verifier)
				const verified = row.code_challenge
					? hasSecret || (verifier !== undefined && sha256(verifier) === row.code_challenge)
					: hasSecret
				if (!verified)
					return oauthError(c, 400, 'invalid_grant', 'code_verifier does not match the code_challenge.')
				const used = await one<{ session_id: string }>(
					db,
					'UPDATE auth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING session_id',
					[codeHash],
				)
				if (!used) return oauthError(c, 400, 'invalid_grant', 'The code is invalid or expired.')
				return c.json(await issueTokens(ctx, used.session_id))
			}

			case 'refresh_token': {
				const tokenHash = sha256(str(body.refresh_token) ?? '')
				const row = await one<{ session_id: string; user_id: string }>(
					db,
					`SELECT r.session_id, s.user_id FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id
					WHERE r.token_hash = $1 AND r.used_at IS NULL AND s.revoked_at IS NULL AND r.created_at > now() - ${REFRESH_IDLE_TIMEOUT}`,
					[tokenHash],
				)
				if (!row) return oauthError(c, 400, 'invalid_grant', 'The refresh token is invalid or expired.')
				const orgId = str(body.organization_id)
				if (orgId && !(await isActiveMember(db, row.user_id, orgId))) {
					return oauthError(
						c,
						400,
						'invalid_request',
						`User is not an active member of organization ${orgId}.`,
					)
				}
				const used = await one<{ session_id: string }>(
					db,
					'UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING session_id',
					[tokenHash],
				)
				if (!used) return oauthError(c, 400, 'invalid_grant', 'The refresh token is invalid or expired.')
				if (orgId)
					await db.query('UPDATE sessions SET organization_id = $2 WHERE id = $1', [row.session_id, orgId])
				return c.json(await issueTokens(ctx, row.session_id))
			}

			case DEVICE_GRANT: {
				const device = await one<DeviceCodeRow>(db, 'SELECT * FROM device_codes WHERE device_code_hash = $1', [
					sha256(str(body.device_code) ?? ''),
				])
				if (!device || device.status === 'consumed') {
					return oauthError(c, 400, 'invalid_grant', 'The device code is invalid.')
				}
				if (device.status === 'denied')
					return oauthError(c, 400, 'access_denied', 'The user denied the request.')
				if (new Date(device.expires_at) < new Date()) {
					return oauthError(c, 400, 'expired_token', 'The device code has expired.')
				}
				if (device.status === 'approved') {
					const consumed = await one<{ session_id: string }>(
						db,
						`UPDATE device_codes SET status = 'consumed' WHERE id = $1 AND status = 'approved' RETURNING session_id`,
						[device.id],
					)
					if (!consumed) return oauthError(c, 400, 'invalid_grant', 'The device code is invalid.')
					return c.json(await issueTokens(ctx, consumed.session_id))
				}
				await db.query('UPDATE device_codes SET last_polled_at = now() WHERE id = $1', [device.id])
				const tooSoon =
					device.last_polled_at &&
					Date.now() - new Date(device.last_polled_at).getTime() < device.interval_seconds * 1000
				return tooSoon
					? oauthError(c, 400, 'slow_down', 'Polling too fast.')
					: oauthError(c, 400, 'authorization_pending', 'The user has not yet completed authorization.')
			}

			default:
				return oauthError(
					c,
					400,
					'unsupported_grant_type',
					`Unsupported grant_type: ${str(body.grant_type) ?? ''}`,
				)
		}
	})

	app.get('/user_management/sessions/logout', async (c) => {
		const { session_id: sessionId, return_to: returnTo } = c.req.query()
		const session = sessionId
			? await one<{ oidc_id_token: string | null }>(
					db,
					'UPDATE sessions SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 RETURNING oidc_id_token',
					[sessionId],
				)
			: undefined
		if (session) await db.query('DELETE FROM refresh_tokens WHERE session_id = $1', [sessionId])
		const safeReturnTo =
			returnTo && URL.canParse(returnTo) && allowedOrigins.has(new URL(returnTo).origin) ? returnTo : undefined
		const url = await oidc.endSessionUrl({ idToken: session?.oidc_id_token, postLogoutRedirectUri: safeReturnTo })
		if (url) return c.redirect(url)
		return safeReturnTo ? c.redirect(safeReturnTo) : page(c, 'Signed out', '<p>You are signed out.</p>')
	})

	app.get('/sso/jwks/:clientId', async (c) => {
		if (c.req.param('clientId') !== cfg.clientId) return c.json({ message: 'Not found' }, 404)
		return c.json(await jwks(db))
	})

	// --- Device flow (CLI, plugins) ---

	app.post('/user_management/authorize/device', async (c) => {
		const body = await readBody(c)
		if (body.client_id !== cfg.clientId) return oauthError(c, 400, 'invalid_client', 'Unknown client_id.')
		await cleanupExpired(db)
		const deviceCode = randomToken()
		const userCode = newUserCode()
		await db.query(
			`INSERT INTO device_codes (id, device_code_hash, user_code, interval_seconds, expires_at)
			VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
			[newId('device_code'), sha256(deviceCode), userCode, DEVICE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS],
		)
		const verificationUri = `${cfg.publicOrigin}/user_management/device`
		return c.json({
			device_code: deviceCode,
			user_code: formatUserCode(userCode),
			verification_uri: verificationUri,
			verification_uri_complete: `${verificationUri}?user_code=${formatUserCode(userCode)}`,
			expires_in: DEVICE_CODE_TTL_SECONDS,
			interval: DEVICE_POLL_INTERVAL_SECONDS,
		})
	})

	// The confirm form carries a CSRF token so a cross-site POST cannot approve a code silently.
	app.get('/user_management/device', (c) => {
		const csrf = randomToken(16)
		setCookie(c, CSRF_COOKIE, csrf, {
			httpOnly: true,
			sameSite: 'Strict',
			secure: cfg.publicOrigin.startsWith('https:'),
			path: '/user_management/device',
		})
		const userCode = c.req.query('user_code') ?? ''
		return page(
			c,
			'Confirm device sign-in',
			html`<p>Check that this code matches the one shown in your terminal.</p>
				<form method="post">
					<input type="hidden" name="csrf" value="${csrf}" />
					<p>
						<input
							name="user_code"
							value="${userCode}"
							placeholder="XXXX-XXXX"
							autocomplete="off"
							required
						/>
					</p>
					<p><button type="submit">Continue</button></p>
				</form>`,
		)
	})

	app.post('/user_management/device', async (c) => {
		const body = await readBody(c)
		const cookie = getCookie(c, CSRF_COOKIE)
		const csrf = str(body.csrf)
		if (!cookie || !csrf || !safeEqual(cookie, csrf)) {
			return page(
				c,
				'Try again',
				'<p>The form expired. <a href="/user_management/device">Start again</a>.</p>',
				400,
			)
		}
		const device = await one<{ id: string }>(
			db,
			`SELECT id FROM device_codes WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`,
			[normalizeUserCode(str(body.user_code) ?? '')],
		)
		if (!device)
			return page(
				c,
				'Unknown code',
				'<p>This code is invalid or expired. <a href="/user_management/device">Try again</a>.</p>',
				400,
			)
		return startLogin(c, { kind: 'device', device_code_id: device.id })
	})
}
