import { timingSafeEqual } from 'node:crypto'

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { sha256 } from './ids'

export type Body = Record<string, unknown>

/** Reads a JSON or form-encoded body; an empty or unparsable body is `{}` (the WorkOS SDK posts `null` bodies). */
export async function readBody(c: Context): Promise<Body> {
	const text = await c.req.text()
	if (!text) return {}
	if ((c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
		return Object.fromEntries(new URLSearchParams(text))
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null ? (parsed as Body) : {}
	} catch {
		return {}
	}
}

export const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

export const safeEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))

/** OAuth-style error, the shape AuthKit-JS, the CLI and session-sdk-auth parse from /authenticate. */
export const oauthError = (c: Context, status: ContentfulStatusCode, error: string, description: string) =>
	c.json({ error, error_description: description }, status)

/** WorkOS REST error, the shape the Node SDK maps to its exception classes. */
export const apiError = (c: Context, status: ContentfulStatusCode, code: string, message: string) =>
	c.json({ code, message }, status)

export const notFound = (c: Context, entity: string, id: string) =>
	c.json({ code: 'entity_not_found', message: `${entity} not found: '${id}'.`, entity_id: id }, 404)

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** `body` is trusted markup; interpolate user data with `escapeHtml` via the `html` tag. */
export function page(c: Context, title: string, body: string, status: ContentfulStatusCode = 200) {
	return c.html(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font-size:1.1rem;padding:.5rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
		status,
	)
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
	return strings.reduce((out, str, i) => out + str + (i < values.length ? escapeHtml(String(values[i])) : ''), '')
}
