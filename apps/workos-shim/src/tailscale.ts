import type { Identity } from './store'

/**
 * The identity `tailscale serve` adds to requests from user-owned devices. Tagged devices get no
 * headers. serve drops client-sent copies of these headers, but anything that reaches the shim
 * without going through serve can set them, so tailscale mode must only be exposed through serve.
 */
export function tailscaleIdentity(header: (name: string) => string | undefined): Identity | undefined {
	const email = decodeRfc2047(header('Tailscale-User-Login') ?? '').trim()
	if (!email) return undefined
	const [firstName = '', ...rest] = decodeRfc2047(header('Tailscale-User-Name') ?? '')
		.trim()
		.split(/\s+/)
	return {
		sub: null,
		email,
		// Tailscale authenticated the login through the tailnet's identity provider.
		emailVerified: true,
		firstName: firstName || null,
		lastName: rest.join(' ') || null,
		picture: header('Tailscale-User-Profile-Pic') || null,
		groups: [],
	}
}

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g

/** Decodes RFC 2047 encoded words (`=?utf-8?q?...?=`). Tailscale (Go's mime.QEncoding) only emits UTF-8 ones. */
export function decodeRfc2047(value: string): string {
	// Whitespace between two encoded words is not part of the text (RFC 2047 section 6.2).
	return value
		.replace(/(\?=)\s+(?==\?)/g, '$1')
		.replace(ENCODED_WORD, (word, charset: string, encoding: string, text: string) => {
			if (charset.toLowerCase() !== 'utf-8') return word
			const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : quotedPrintableBytes(text)
			return new TextDecoder().decode(bytes)
		})
}

function quotedPrintableBytes(text: string): Uint8Array {
	const bytes: number[] = []
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code === 0x5f) {
			bytes.push(0x20) // "_" is a space
		} else if (code === 0x3d) {
			bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16)) // "=XX"
			i += 2
		} else {
			bytes.push(code)
		}
	}
	return Uint8Array.from(bytes)
}
