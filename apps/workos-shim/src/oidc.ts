import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'

import type { OidcConfig } from './config'

interface Discovery {
	issuer: string
	authorization_endpoint: string
	token_endpoint: string
	jwks_uri: string
	end_session_endpoint?: string
}

export interface IdTokenClaims extends JWTPayload {
	sub: string
	email?: string
	email_verified?: boolean
	given_name?: string
	family_name?: string
	picture?: string
	groups?: string[]
}

export type Oidc = ReturnType<typeof createOidc>

/** Confidential OIDC client of the upstream IdP (Keycloak). */
export function createOidc(cfg: OidcConfig, redirectUri: string) {
	let discovery: Promise<Discovery> | undefined
	let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

	const discover = () =>
		(discovery ??= fetch(`${cfg.issuer}/.well-known/openid-configuration`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
				return (await res.json()) as Discovery
			})
			.catch((error) => {
				discovery = undefined
				throw error
			}))

	return {
		async authorizationUrl(params: { state: string; nonce: string; codeChallenge: string; loginHint?: string }) {
			const url = new URL((await discover()).authorization_endpoint)
			url.search = new URLSearchParams({
				response_type: 'code',
				client_id: cfg.clientId,
				redirect_uri: redirectUri,
				scope: cfg.scopes,
				state: params.state,
				nonce: params.nonce,
				code_challenge: params.codeChallenge,
				code_challenge_method: 'S256',
			}).toString()
			if (params.loginHint) url.searchParams.set('login_hint', params.loginHint)
			return url.toString()
		},

		/** Exchanges the code and returns the verified id_token claims plus the raw id_token (for logout hints). */
		async exchangeCode(code: string, codeVerifier: string, nonce: string) {
			const d = await discover()
			const res = await fetch(d.token_endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
					client_id: cfg.clientId,
					client_secret: cfg.clientSecret,
				}),
			})
			if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status} ${await res.text()}`)
			const { id_token: idToken } = (await res.json()) as { id_token?: string }
			if (!idToken) throw new Error('OIDC token response has no id_token')
			jwks ??= createRemoteJWKSet(new URL(d.jwks_uri))
			const { payload } = await jwtVerify<IdTokenClaims>(idToken, jwks, {
				issuer: d.issuer,
				audience: cfg.clientId,
			})
			if (payload.nonce !== nonce) throw new Error('OIDC id_token nonce mismatch')
			return { claims: payload, idToken }
		},

		async endSessionUrl(params: { idToken?: string | null; postLogoutRedirectUri?: string }) {
			const endpoint = (await discover()).end_session_endpoint
			if (!endpoint) return undefined
			const url = new URL(endpoint)
			url.searchParams.set('client_id', cfg.clientId)
			if (params.idToken) url.searchParams.set('id_token_hint', params.idToken)
			if (params.postLogoutRedirectUri)
				url.searchParams.set('post_logout_redirect_uri', params.postLogoutRedirectUri)
			return url.toString()
		},
	}
}
