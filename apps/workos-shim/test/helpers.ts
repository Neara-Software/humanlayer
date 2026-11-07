import { createServer } from 'node:net'

import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'

import { type FakeUser, fakeOidcApp } from '../dev/fake-oidc'
import { createApp } from '../src/app'
import { type Config, loadConfig } from '../src/config'
import { type Db, postgresDb } from '../src/db'
import { sha256 } from '../src/ids'

export const API_KEY = 'sk_test_shim'
export const CLIENT_ID = 'client_test'
export const APP_ORIGIN = 'http://app.test'
export const REDIRECT_URI = `${APP_ORIGIN}/callback`

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer()
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number }
			server.close(() => resolve(port))
		})
	})
}

export function pgliteDb(): Db {
	const pg = new PGlite()
	return {
		query: async (text, params) => (await pg.query(text, params)).rows as never,
		exec: async (text) => {
			await pg.exec(text)
		},
		close: () => pg.close(),
	}
}

/**
 * PGlite by default. Set SHIM_TEST_DATABASE_URL (a Postgres URL with CREATE DATABASE rights) to run
 * against real Postgres through postgres.js, the production driver; each shim then gets a throwaway database.
 */
async function testDb(): Promise<Db> {
	const adminUrl = process.env.SHIM_TEST_DATABASE_URL
	if (!adminUrl) return pgliteDb()
	const name = `workos_shim_test_${crypto.randomUUID().replaceAll('-', '')}`
	const admin = postgresDb(adminUrl, 'public')
	await admin.exec(`CREATE DATABASE ${name}`)
	const url = new URL(adminUrl)
	url.pathname = `/${name}`
	const db = postgresDb(url.toString())
	return {
		...db,
		close: async () => {
			await db.close()
			await admin.exec(`DROP DATABASE ${name}`)
			await admin.close()
		},
	}
}

/** Stand-in for the riptide database with just the `organizations` columns the seed touches. */
export async function riptideDb(): Promise<Db> {
	const db = pgliteDb()
	await db.exec(`CREATE TABLE organizations (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		name text NOT NULL,
		workos_organization_id text NOT NULL
	)`)
	return db
}

/** The dev fake IdP on a free port, as an `OIDC_ISSUER`. */
export async function startFakeOidc() {
	const port = await freePort()
	const { app, state } = await fakeOidcApp('test', 'oidc-secret')
	const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
	return {
		issuer: `http://127.0.0.1:${port}/realms/test`,
		state,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

export type FakeOidc = Awaited<ReturnType<typeof startFakeOidc>>

export async function startShim(oidc: FakeOidc, env: Record<string, string> = {}) {
	const port = await freePort()
	const origin = `http://127.0.0.1:${port}`
	const cfg: Config = loadConfig({
		SHIM_PORT: String(port),
		SHIM_PUBLIC_ORIGIN: origin,
		SHIM_DATABASE_URL: 'pglite://memory',
		SHIM_API_KEY: API_KEY,
		SHIM_CLIENT_ID: CLIENT_ID,
		SHIM_ALLOWED_REDIRECT_URIS: `${REDIRECT_URI},${APP_ORIGIN}/`,
		OIDC_ISSUER: oidc.issuer,
		OIDC_CLIENT_ID: 'humanlayer',
		OIDC_CLIENT_SECRET: oidc.state.clientSecret,
		SHIM_ALLOWED_EMAIL_DOMAINS: 'neara.com',
		SHIM_ADMIN_EMAILS: 'admin@neara.com',
		...env,
	})
	const db = await testDb()
	const app = await createApp(cfg, db)
	const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
	return {
		origin,
		port,
		cfg,
		db,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await db.close()
		},
	}
}

export type Shim = Awaited<ReturnType<typeof startShim>>

export const location = (res: Response) => {
	const value = res.headers.get('location')
	if (!value) throw new Error(`expected a redirect, got ${res.status}: ${res.statusText}`)
	return value
}

export const get = (url: string, init?: RequestInit) => fetch(url, { redirect: 'manual', ...init })

export function pkce() {
	const verifier = crypto.randomUUID() + crypto.randomUUID()
	return { verifier, challenge: sha256(verifier) }
}

/** Runs the browser redirect chain (app -> shim -> fake Keycloak -> shim -> app) and returns the code sent to the app. */
export async function browserLogin(shim: Shim, oidc: FakeOidc, user: FakeUser, extra: Record<string, string> = {}) {
	const { verifier, challenge } = pkce()
	oidc.state.nextUser = user
	const authorize = new URL(`${shim.origin}/user_management/authorize`)
	authorize.search = new URLSearchParams({
		provider: 'authkit',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		state: 'app-state',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		...extra,
	}).toString()
	const toIdp = location(await get(authorize.toString()))
	const toCallback = location(await get(toIdp))
	const callback = await get(toCallback)
	if (callback.status !== 302) return { callback, verifier }
	const back = new URL(location(callback))
	return {
		callback,
		verifier,
		code: back.searchParams.get('code') ?? '',
		state: back.searchParams.get('state'),
		back,
	}
}

export async function authenticate(shim: Shim, body: Record<string, string>) {
	const res = await fetch(`${shim.origin}/user_management/authenticate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
	})
	return { status: res.status, json: (await res.json()) as Record<string, any> }
}

/** Verifies an access token the way apps/riptide-api/src/auth/jwt-validator.ts does: JWKS by kid, issuer from the token. */
export async function verifyLikeRiptide(shim: Shim, token: string) {
	const jwks = (await (await fetch(`${shim.origin}/sso/jwks/${CLIENT_ID}`)).json()) as JSONWebKeySet
	const issuer = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).iss
	const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer })
	return { payload, protectedHeader }
}
