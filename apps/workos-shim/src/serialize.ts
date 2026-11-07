// Row -> WorkOS JSON (snake_case), matching what the @workos-inc/node and authkit-js deserializers read.
import type { ApiKeyRow, DomainRow, InvitationRow, MembershipRow, OrganizationRow, UserRow } from './rows'

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null)

export function userJson(u: UserRow) {
	return {
		object: 'user',
		id: u.id,
		email: u.email,
		email_verified: u.email_verified,
		first_name: u.first_name,
		last_name: u.last_name,
		profile_picture_url: u.profile_picture_url,
		last_sign_in_at: iso(u.last_sign_in_at),
		locale: null,
		external_id: u.external_id,
		metadata: u.metadata,
		created_at: iso(u.created_at),
		updated_at: iso(u.updated_at),
	}
}

export function domainJson(d: DomainRow) {
	return {
		object: 'organization_domain',
		id: d.id,
		domain: d.domain,
		organization_id: d.organization_id,
		state: d.state,
		verification_strategy: d.verification_strategy,
		created_at: iso(d.created_at),
		updated_at: iso(d.updated_at),
	}
}

export function organizationJson(o: OrganizationRow, domains: DomainRow[]) {
	return {
		object: 'organization',
		id: o.id,
		name: o.name,
		allow_profiles_outside_organization: false,
		domains: domains.map(domainJson),
		stripe_customer_id: o.stripe_customer_id,
		external_id: o.external_id,
		metadata: o.metadata,
		created_at: iso(o.created_at),
		updated_at: iso(o.updated_at),
	}
}

export function membershipJson(m: MembershipRow) {
	return {
		object: 'organization_membership',
		id: m.id,
		user_id: m.user_id,
		organization_id: m.organization_id,
		organization_name: m.organization_name,
		status: m.status,
		role: { slug: m.role_slug },
		roles: [{ slug: m.role_slug }],
		directory_managed: false,
		custom_attributes: {},
		created_at: iso(m.created_at),
		updated_at: iso(m.updated_at),
	}
}

/** `pending` past its expiry is reported as `expired`, as WorkOS does. */
export const invitationState = (i: InvitationRow) =>
	i.state === 'pending' && new Date(i.expires_at) < new Date() ? 'expired' : i.state

export function invitationJson(i: InvitationRow, acceptInvitationBaseUrl: string) {
	return {
		object: 'invitation',
		id: i.id,
		email: i.email,
		state: invitationState(i),
		accepted_at: iso(i.accepted_at),
		revoked_at: iso(i.revoked_at),
		expires_at: iso(i.expires_at),
		organization_id: i.organization_id,
		inviter_user_id: i.inviter_user_id,
		accepted_user_id: i.accepted_user_id,
		role_slug: i.role_slug,
		token: i.token,
		accept_invitation_url: `${acceptInvitationBaseUrl}?invitation_token=${encodeURIComponent(i.token)}`,
		created_at: iso(i.created_at),
		updated_at: iso(i.updated_at),
	}
}

export function apiKeyJson(k: ApiKeyRow) {
	return {
		object: 'api_key',
		id: k.id,
		owner: { type: 'user', id: k.user_id, organization_id: k.organization_id },
		name: k.name,
		obfuscated_value: k.obfuscated_value,
		last_used_at: iso(k.last_used_at),
		expires_at: iso(k.expires_at),
		permissions: k.permissions,
		created_at: iso(k.created_at),
		updated_at: iso(k.updated_at),
	}
}
