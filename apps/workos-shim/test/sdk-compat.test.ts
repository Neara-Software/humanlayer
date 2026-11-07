import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WorkosSdkAdapterLive } from '../../riptide-api/src/lib/workos-service'
import { seed } from '../src/cli'
import type { Db } from '../src/db'
import {
	API_KEY,
	authenticate,
	browserLogin,
	CLIENT_ID,
	type FakeOidc,
	REDIRECT_URI,
	riptideDb,
	type Shim,
	startFakeOidc,
	startShim,
	verifyLikeRiptide,
} from './helpers'

// The contract test: the API's real WorkOS adapter, pointed at the shim the way the self-host env does.
let oidc: FakeOidc
let shim: Shim
let riptide: Db
let workos: WorkosSdkAdapterLive
let org: { orgId: string; internalOrgId: string }
const users: Record<'admin' | 'member', { id: string; refreshToken: string }> = {
	admin: { id: '', refreshToken: '' },
	member: { id: '', refreshToken: '' },
}

async function signIn(sub: string, email: string) {
	const login = await browserLogin(shim, oidc, { sub, email, given_name: sub })
	const { json } = await authenticate(shim, {
		grant_type: 'authorization_code',
		code: login.code ?? '',
		code_verifier: login.verifier,
	})
	return { id: json.user.id as string, refreshToken: json.refresh_token as string }
}

const errorOf = (promise: Promise<unknown>) =>
	promise.then(
		() => Promise.reject(new Error('expected a rejection')),
		(e) => e,
	)

beforeAll(async () => {
	oidc = await startFakeOidc()
	shim = await startShim(oidc)
	riptide = await riptideDb()
	org = await seed(shim.db, riptide, 'Neara')
	shim.cfg.defaultOrgId = org.orgId
	users.admin = await signIn('kc-admin', 'admin@neara.com')
	users.member = await signIn('kc-member', 'member@neara.com')

	process.env.WORKOS_API_HOSTNAME = '127.0.0.1'
	process.env.WORKOS_API_PORT = String(shim.port)
	process.env.WORKOS_API_HTTPS = 'false'
	workos = new WorkosSdkAdapterLive(API_KEY, CLIENT_ID, REDIRECT_URI)
})

afterAll(async () => {
	await shim.close()
	await riptide.close()
	await oidc.close()
})

describe('WorkosSdkAdapterLive against the shim', () => {
	it('rejects calls without the API key', async () => {
		const anonymous = new WorkosSdkAdapterLive('sk_wrong', CLIENT_ID, REDIRECT_URI)
		expect((await errorOf(anonymous.userManagement.getUser(users.admin.id))).name).toBe('UnauthorizedException')
	})

	it('reads users', async () => {
		const user = await workos.userManagement.getUser(users.admin.id)
		expect(user).toMatchObject({
			id: users.admin.id,
			email: 'admin@neara.com',
			firstName: 'kc-admin',
			emailVerified: true,
		})
		expect(user.createdAt).toMatch(/Z$/)

		const byOrg = await (await workos.userManagement.listUsers({ organizationId: org.orgId })).autoPagination()
		expect(byOrg.map((u) => u.email).sort()).toEqual(['admin@neara.com', 'member@neara.com'])
		const byEmail = await workos.userManagement.listUsers({ email: 'MEMBER@neara.com' })
		expect(byEmail.data.map((u) => u.id)).toEqual([users.member.id])

		const page1 = await workos.userManagement.listUsers({ organizationId: org.orgId, limit: 1 })
		expect(page1.data).toHaveLength(1)
		const page2 = await workos.userManagement.listUsers({
			organizationId: org.orgId,
			limit: 1,
			after: page1.listMetadata.after ?? '',
		})
		expect(page2.data[0]?.id).not.toBe(page1.data[0]?.id)
		expect(page2.listMetadata.after).toBeNull()

		const missing = await errorOf(workos.userManagement.getUser('user_missing'))
		expect(missing).toMatchObject({ name: 'NotFoundException', status: 404, code: 'entity_not_found' })
	})

	it('manages organizations and domains', async () => {
		const created = await workos.organizations.createOrganization({
			name: 'Acme',
			domainData: [{ domain: 'acme.test', state: 'verified' as never }],
		})
		expect(created).toMatchObject({ name: 'Acme', domains: [{ domain: 'acme.test', state: 'verified' }] })
		const updated = await workos.organizations.updateOrganization({
			organization: created.id,
			stripeCustomerId: 'cus_123',
			metadata: { internal_org_id: 'uuid-1' },
		})
		expect(updated).toMatchObject({ stripeCustomerId: 'cus_123', metadata: { internal_org_id: 'uuid-1' } })

		const domain = await workos.organizationDomains.create({ domain: 'neara.com', organizationId: org.orgId })
		expect(domain).toMatchObject({ domain: 'neara.com', organizationId: org.orgId, state: 'verified' })
		const fetched = await workos.organizations.getOrganization(org.orgId)
		expect(fetched).toMatchObject({
			id: org.orgId,
			name: 'Neara',
			metadata: { internal_org_id: org.internalOrgId },
		})
		expect(fetched.domains.map((d) => d.domain)).toEqual(['neara.com'])
		await workos.organizationDomains.delete(domain.id)
		expect((await workos.organizations.getOrganization(org.orgId)).domains).toEqual([])

		expect(
			(await errorOf(workos.adminPortal.generateLink({ organization: org.orgId, intent: 'sso' as never })))
				.status,
		).toBe(501)
	})

	it('manages memberships', async () => {
		expect(await workos.countActiveOrganizationMemberships(org.orgId)).toBe(2)
		const [membership] = (
			await workos.userManagement.listOrganizationMemberships({
				userId: users.member.id,
				organizationId: org.orgId,
			})
		).data
		expect(membership).toMatchObject({
			userId: users.member.id,
			organizationId: org.orgId,
			status: 'active',
			role: { slug: 'member' },
		})
		const id = membership?.id ?? ''

		expect((await workos.userManagement.updateOrganizationMembership(id, { roleSlug: 'admin' })).role.slug).toBe(
			'admin',
		)
		expect((await workos.userManagement.deactivateOrganizationMembership(id)).status).toBe('inactive')
		expect(await workos.countActiveOrganizationMemberships(org.orgId)).toBe(1)
		const all = await workos.userManagement.listOrganizationMemberships({
			organizationId: org.orgId,
			statuses: ['active', 'inactive'],
		})
		expect(await all.autoPagination()).toHaveLength(2)
		expect((await workos.userManagement.reactivateOrganizationMembership(id)).status).toBe('active')

		const acme = await workos.organizations.createOrganization({ name: 'Acme 2' })
		const created = await workos.userManagement.createOrganizationMembership({
			userId: users.member.id,
			organizationId: acme.id,
			roleSlug: 'admin',
		})
		expect(created).toMatchObject({ organizationId: acme.id, organizationName: 'Acme 2', role: { slug: 'admin' } })
		await workos.userManagement.deleteOrganizationMembership(created.id)
		expect((await workos.userManagement.listOrganizationMemberships({ organizationId: acme.id })).data).toEqual([])

		const notFound = await errorOf(
			workos.userManagement.updateOrganizationMembership('om_missing', { roleSlug: 'admin' }),
		)
		expect(notFound).toMatchObject({ code: 'entity_not_found' })
	})

	it('manages invitations', async () => {
		const sent = await workos.userManagement.sendInvitation({
			email: 'new@neara.com',
			organizationId: org.orgId,
			inviterUserId: users.admin.id,
			roleSlug: 'admin',
			expiresInDays: 7,
		})
		expect(sent).toMatchObject({
			email: 'new@neara.com',
			state: 'pending',
			organizationId: org.orgId,
			roleSlug: 'admin',
		})
		expect(await workos.countPendingInvitations({ workosOrganizationId: org.orgId })).toBe(1)
		expect((await workos.userManagement.getInvitation(sent.id)).id).toBe(sent.id)
		expect((await workos.userManagement.findInvitationByToken(sent.token)).id).toBe(sent.id)
		expect((await workos.userManagement.listInvitations({ email: 'new@neara.com' })).data.map((i) => i.id)).toEqual(
			[sent.id],
		)

		const dup = await errorOf(
			workos.userManagement.sendInvitation({ email: 'new@neara.com', organizationId: org.orgId }),
		)
		expect(dup.message).toContain('already invited')
		const member = await errorOf(
			workos.userManagement.sendInvitation({ email: 'member@neara.com', organizationId: org.orgId }),
		)
		expect(member.message).toContain('already a member')

		// No email is sent: the invitee signs in and the invitation is accepted then.
		const invitee = await signIn('kc-new', 'new@neara.com')
		expect((await workos.userManagement.getInvitation(sent.id)).state).toBe('accepted')
		const [membership] = (await workos.userManagement.listOrganizationMemberships({ userId: invitee.id })).data
		expect(membership?.role.slug).toBe('admin')

		const second = await workos.userManagement.sendInvitation({
			email: 'later@neara.com',
			organizationId: org.orgId,
		})
		expect((await workos.userManagement.revokeInvitation(second.id)).state).toBe('revoked')

		const third = await workos.userManagement.sendInvitation({
			email: 'member2@neara.com',
			organizationId: org.orgId,
		})
		const member2 = await signIn('kc-member2', 'member2@neara.com')
		await shim.db.query(`UPDATE invitations SET state = 'pending', accepted_at = NULL WHERE id = $1`, [third.id])
		expect((await workos.userManagement.acceptInvitation(third.id)).state).toBe('accepted')
		expect((await workos.userManagement.listOrganizationMemberships({ userId: member2.id })).data).toHaveLength(1)
	})

	it('manages user API keys', async () => {
		const expiresAt = new Date(Date.now() + 7 * 86400_000)
		const created = await workos.userManagement.createUserApiKey(users.admin.id, {
			name: 'laptop',
			organizationId: org.orgId,
			expiresAt,
		})
		expect(created).toMatchObject({
			name: 'laptop',
			owner: { type: 'user', id: users.admin.id, organizationId: org.orgId },
		})
		expect(created.value).toMatch(/^sk_/)
		expect(created.expiresAt).toBe(expiresAt.toISOString())

		const listed = await (
			await workos.userManagement.listUserApiKeys(users.admin.id, { organizationId: org.orgId })
		).autoPagination()
		expect(listed.map((k) => k.id)).toEqual([created.id])
		expect(listed[0]).not.toHaveProperty('value')

		const valid = await workos.apiKeys.createValidation({ value: created.value })
		expect(valid.apiKey).toMatchObject({
			id: created.id,
			owner: { type: 'user', id: users.admin.id, organizationId: org.orgId },
		})
		expect((await workos.apiKeys.createValidation({ value: 'sk_nope' })).apiKey).toBeNull()

		await workos.apiKeys.deleteApiKey(created.id)
		expect((await workos.apiKeys.createValidation({ value: created.value })).apiKey).toBeNull()
	})

	it('refreshes server-side with the API key as client secret and builds URLs against the shim', async () => {
		const refreshed = await workos.userManagement.authenticateWithRefreshToken({
			clientId: CLIENT_ID,
			refreshToken: users.member.refreshToken,
			organizationId: org.orgId,
		})
		expect((await verifyLikeRiptide(shim, refreshed.accessToken)).payload).toMatchObject({
			sub: users.member.id,
			org_id: org.orgId,
		})

		const signInUrl = new URL(
			workos.userManagement.getAuthorizationUrl({
				redirectUri: REDIRECT_URI,
				clientId: CLIENT_ID,
				provider: 'authkit',
				organizationId: org.orgId,
			}),
		)
		expect(signInUrl.origin + signInUrl.pathname).toBe(`${shim.origin}/user_management/authorize`)
		expect(workos.userManagement.getJwksUrl(CLIENT_ID)).toBe(`${shim.origin}/sso/jwks/${CLIENT_ID}`)
	})
})
