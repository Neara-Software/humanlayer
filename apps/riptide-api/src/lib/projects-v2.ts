/**
 * Whether Projects V2 is on for a user: their stored user_settings.projects_v2_enabled, or on for
 * everyone when PROJECTS_V2_DEFAULT_ENABLED=true (self-hosted). Unset keeps the stored value only.
 */
export function projectsV2Enabled(stored: boolean | null | undefined): boolean {
	return stored === true || process.env.PROJECTS_V2_DEFAULT_ENABLED === 'true'
}
