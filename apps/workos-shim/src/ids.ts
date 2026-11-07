import { createHash, randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID: 10 chars of millisecond time + 16 random chars, so ids sort by creation time. */
export function ulid(now = Date.now()): string {
	let time = ''
	for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time
	let rand = ''
	for (const byte of randomBytes(16)) rand += CROCKFORD[byte % 32]
	return time + rand
}

export const newId = (prefix: string) => `${prefix}_${ulid()}`

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')
