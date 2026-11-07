export interface Config {
	port: number
	host: string
	publicOrigin: string
	databaseUrl: string
	apiKey: string
	clientId: string
	allowedRedirectUris: string[]
	oidc: { issuer: string; clientId: string; clientSecret: string; scopes: string }
	allowedEmailDomains: string[]
	requiredGroup: string | undefined
	adminEmails: string[]
	defaultOrgId: string | undefined
	accessTokenTtlSeconds: number
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
	return {
		port: Number(env.SHIM_PORT ?? 4300),
		host: env.SHIM_HOST ?? '127.0.0.1',
		publicOrigin: required(env, 'SHIM_PUBLIC_ORIGIN').replace(/\/$/, ''),
		databaseUrl: required(env, 'SHIM_DATABASE_URL'),
		apiKey: required(env, 'SHIM_API_KEY'),
		clientId: required(env, 'SHIM_CLIENT_ID'),
		allowedRedirectUris: list(env.SHIM_ALLOWED_REDIRECT_URIS),
		oidc: {
			issuer: required(env, 'OIDC_ISSUER').replace(/\/$/, ''),
			clientId: required(env, 'OIDC_CLIENT_ID'),
			clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
			scopes: env.OIDC_SCOPES ?? 'openid email profile',
		},
		allowedEmailDomains: list(env.SHIM_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
		requiredGroup: env.SHIM_REQUIRED_GROUP || undefined,
		adminEmails: list(env.SHIM_ADMIN_EMAILS).map((e) => e.toLowerCase()),
		defaultOrgId: env.SHIM_DEFAULT_ORG_ID || undefined,
		accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
	}
}
