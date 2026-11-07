import { exportJWK, generateKeyPair, importJWK, type JWK, type JWTPayload, SignJWT } from 'jose'

import { type Db, one } from './db'
import { newId, ulid } from './ids'

interface SigningKey {
	kid: string
	privateKey: CryptoKey
}

export async function addSigningKey(db: Db): Promise<string> {
	const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
	const kid = newId('sso_oidc_key_pair')
	const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
	await db.query(
		'INSERT INTO signing_keys (kid, private_jwk, public_jwk) VALUES ($1, $2::text::jsonb, $3::text::jsonb)',
		[kid, JSON.stringify(await exportJWK(privateKey)), JSON.stringify(publicJwk)],
	)
	return kid
}

/** The newest key signs; every stored key stays published so tokens signed before a rotation still verify. */
export async function currentSigningKey(db: Db): Promise<SigningKey> {
	const row = await one<{ kid: string; private_jwk: JWK }>(
		db,
		'SELECT kid, private_jwk FROM signing_keys ORDER BY created_at DESC, kid DESC LIMIT 1',
	)
	if (!row) {
		await addSigningKey(db)
		return currentSigningKey(db)
	}
	return { kid: row.kid, privateKey: (await importJWK(row.private_jwk, 'RS256')) as CryptoKey }
}

export async function jwks(db: Db): Promise<{ keys: JWK[] }> {
	const rows = await db.query<{ public_jwk: JWK }>('SELECT public_jwk FROM signing_keys ORDER BY created_at DESC')
	return { keys: rows.map((row) => row.public_jwk) }
}

export interface AccessTokenClaims {
	sub: string
	sid: string
	org_id?: string
	internal_org_id?: string
	role?: string
}

export async function signAccessToken(
	key: SigningKey,
	issuer: string,
	ttlSeconds: number,
	claims: AccessTokenClaims,
): Promise<string> {
	const payload: JWTPayload = { ...claims, permissions: [] }
	if (claims.role) payload.roles = [claims.role]
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
		.setIssuer(issuer)
		.setIssuedAt()
		.setExpirationTime(`${ttlSeconds}s`)
		.setJti(ulid())
		.sign(key.privateKey)
}
