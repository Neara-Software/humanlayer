export type AuthMode = 'oidc' | 'tailscale'

export interface OidcConfig {
	issuer: string
	clientId: string
	clientSecret: string
	scopes: string
}

export interface Config {
	authMode: AuthMode
	port: number
	host: string
	publicOrigin: string
	databaseUrl: string
	apiKey: string
	clientId: string
	allowedRedirectUris: string[]
	/** Unset in tailscale mode. */
	oidc: OidcConfig | undefined
	allowedEmailDomains: string[]
	requiredGroup: string | undefined
	adminEmails: string[]
	defaultOrgId: string | undefined
	accessTokenTtlSeconds: number
	oidcLogout: boolean
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
	const value = env[name]
	if (!value) throw new Error(`${name} is required`)
	return value
}

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
}

export function loadConfig(env: Env = process.env): Config {
	const authMode = env.SHIM_AUTH_MODE ?? 'oidc'
	if (authMode !== 'oidc' && authMode !== 'tailscale') {
		throw new Error(`SHIM_AUTH_MODE must be oidc or tailscale, not ${authMode}`)
	}
	if (authMode === 'tailscale' && env.SHIM_REQUIRED_GROUP) {
		throw new Error('SHIM_REQUIRED_GROUP needs SHIM_AUTH_MODE=oidc: Tailscale sends no groups')
	}
	return {
		authMode,
		port: Number(env.SHIM_PORT ?? 8720),
		host: env.SHIM_HOST ?? '127.0.0.1',
		publicOrigin: required(env, 'SHIM_PUBLIC_ORIGIN').replace(/\/$/, ''),
		databaseUrl: required(env, 'SHIM_DATABASE_URL'),
		apiKey: required(env, 'SHIM_API_KEY'),
		clientId: required(env, 'SHIM_CLIENT_ID'),
		allowedRedirectUris: list(env.SHIM_ALLOWED_REDIRECT_URIS),
		oidc:
			authMode === 'oidc'
				? {
						issuer: required(env, 'OIDC_ISSUER').replace(/\/$/, ''),
						clientId: required(env, 'OIDC_CLIENT_ID'),
						clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
						scopes: env.OIDC_SCOPES ?? 'openid email profile',
					}
				: undefined,
		allowedEmailDomains: list(env.SHIM_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
		requiredGroup: env.SHIM_REQUIRED_GROUP || undefined,
		adminEmails: list(env.SHIM_ADMIN_EMAILS).map((e) => e.toLowerCase()),
		defaultOrgId: env.SHIM_DEFAULT_ORG_ID || undefined,
		accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
		oidcLogout: env.SHIM_OIDC_LOGOUT === 'true',
	}
}
