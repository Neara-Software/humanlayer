import postgres from 'postgres'

/** The few operations the shim needs, so tests can run on PGlite and production on postgres.js. */
export interface Db {
	query<T>(text: string, params?: unknown[]): Promise<T[]>
	exec(text: string): Promise<void>
	close(): Promise<void>
}

export async function one<T>(db: Db, text: string, params?: unknown[]): Promise<T | undefined> {
	return (await db.query<T>(text, params))[0]
}

/** For statements that always return a row (INSERT/UPDATE ... RETURNING on a row known to exist). */
export async function oneOrThrow<T>(db: Db, text: string, params?: unknown[]): Promise<T> {
	const row = await one<T>(db, text, params)
	if (row === undefined) throw new Error(`Expected a row from: ${text}`)
	return row
}

export function postgresDb(url: string, searchPath = 'workos_shim'): Db {
	const sql = postgres(url, { connection: { search_path: searchPath }, onnotice: () => {} })
	return {
		query: async <T>(text: string, params: unknown[] = []) =>
			Array.from(await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as T[],
		exec: async (text) => {
			await sql.unsafe(text)
		},
		close: () => sql.end(),
	}
}

export const MIGRATIONS = `
CREATE SCHEMA IF NOT EXISTS workos_shim;
SET search_path TO workos_shim;

CREATE TABLE IF NOT EXISTS signing_keys (
	kid text PRIMARY KEY,
	private_jwk jsonb NOT NULL,
	public_jwk jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
	id text PRIMARY KEY,
	oidc_sub text UNIQUE,
	email text NOT NULL UNIQUE,
	email_verified boolean NOT NULL DEFAULT false,
	first_name text,
	last_name text,
	profile_picture_url text,
	external_id text,
	metadata jsonb NOT NULL DEFAULT '{}',
	last_sign_in_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
	id text PRIMARY KEY,
	name text NOT NULL,
	external_id text,
	stripe_customer_id text,
	metadata jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_domains (
	id text PRIMARY KEY,
	organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	domain text NOT NULL,
	state text NOT NULL,
	verification_strategy text NOT NULL DEFAULT 'manual',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	role_slug text NOT NULL,
	status text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS invitations (
	id text PRIMARY KEY,
	email text NOT NULL,
	organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
	inviter_user_id text,
	accepted_user_id text,
	role_slug text,
	token text NOT NULL UNIQUE,
	state text NOT NULL DEFAULT 'pending',
	expires_at timestamptz NOT NULL,
	accepted_at timestamptz,
	revoked_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (lower(email));

CREATE TABLE IF NOT EXISTS api_keys (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	name text NOT NULL,
	value_hash text NOT NULL UNIQUE,
	obfuscated_value text NOT NULL,
	permissions jsonb NOT NULL DEFAULT '[]',
	expires_at timestamptz,
	last_used_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id text,
	oidc_id_token text,
	revoked_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
	token_hash text PRIMARY KEY,
	session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	used_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- A login started at the shim and waiting for the Keycloak callback.
CREATE TABLE IF NOT EXISTS pending_logins (
	state text PRIMARY KEY,
	kind text NOT NULL,
	nonce text NOT NULL,
	code_verifier text NOT NULL,
	client_redirect_uri text,
	client_state text,
	code_challenge text,
	organization_id text,
	device_code_id text,
	expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
	code_hash text PRIMARY KEY,
	session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	redirect_uri text NOT NULL,
	code_challenge text,
	used_at timestamptz,
	expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS device_codes (
	id text PRIMARY KEY,
	device_code_hash text NOT NULL UNIQUE,
	user_code text NOT NULL UNIQUE,
	status text NOT NULL DEFAULT 'pending',
	session_id text REFERENCES sessions(id) ON DELETE CASCADE,
	interval_seconds integer NOT NULL,
	last_polled_at timestamptz,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
`

export async function migrate(db: Db): Promise<void> {
	await db.exec(MIGRATIONS)
}
