// Row shapes of the workos_shim tables (see MIGRATIONS in db.ts).

export interface UserRow {
	id: string
	oidc_sub: string | null
	email: string
	email_verified: boolean
	first_name: string | null
	last_name: string | null
	profile_picture_url: string | null
	external_id: string | null
	metadata: Record<string, string>
	last_sign_in_at: Date | null
	created_at: Date
	updated_at: Date
}

export interface OrganizationRow {
	id: string
	name: string
	external_id: string | null
	stripe_customer_id: string | null
	metadata: Record<string, string>
	created_at: Date
	updated_at: Date
}

export interface DomainRow {
	id: string
	organization_id: string
	domain: string
	state: string
	verification_strategy: string
	created_at: Date
	updated_at: Date
}

export interface MembershipRow {
	id: string
	user_id: string
	organization_id: string
	organization_name: string
	role_slug: string
	status: 'active' | 'inactive' | 'pending'
	created_at: Date
	updated_at: Date
}

export interface InvitationRow {
	id: string
	email: string
	organization_id: string | null
	inviter_user_id: string | null
	accepted_user_id: string | null
	role_slug: string | null
	token: string
	state: 'pending' | 'accepted' | 'revoked'
	expires_at: Date
	accepted_at: Date | null
	revoked_at: Date | null
	created_at: Date
	updated_at: Date
}

export interface ApiKeyRow {
	id: string
	user_id: string
	organization_id: string
	name: string
	obfuscated_value: string
	permissions: string[]
	expires_at: Date | null
	last_used_at: Date | null
	created_at: Date
	updated_at: Date
}

export interface PendingLoginRow {
	state: string
	kind: 'authorize' | 'device'
	nonce: string
	code_verifier: string
	client_redirect_uri: string | null
	client_state: string | null
	code_challenge: string | null
	organization_id: string | null
	device_code_id: string | null
}

export interface DeviceCodeRow {
	id: string
	status: 'pending' | 'approved' | 'denied' | 'consumed'
	session_id: string | null
	interval_seconds: number
	last_polled_at: Date | null
	expires_at: Date
}
