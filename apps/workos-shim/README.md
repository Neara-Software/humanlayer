# @humanlayer/workos-shim

A small WorkOS-compatible server for self-hosting. It speaks the parts of the WorkOS REST API that the
riptide API, AuthKit-JS, the CLI and the plugins use. State lives in Postgres schema `workos_shim`;
migrations run at startup.

Sign-in (`SHIM_AUTH_MODE`):

- `oidc` (default): the shim is a confidential OIDC client of Keycloak (auth code + PKCE).
- `tailscale`: the user is whoever `tailscale serve` says sent the request (`Tailscale-User-Login`,
  `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`), with no login step. Requests without these headers
  (tagged devices, direct access) get a 403 page. The shim trusts the headers, so in this mode it must only be
  reachable through `tailscale serve`: anything that can reach it directly can claim any identity.

Both modes apply the same policy (email domain, invitations, default org, admin emails). Users are matched
by IdP subject, then by email, so a later Keycloak login takes over a user first made through Tailscale.

```sh
bun src/main.ts                                   # serve
bun src/cli.ts seed --org-name Neara --riptide-database-url postgres://...   # prints SHIM_DEFAULT_ORG_ID=org_...
bun src/cli.ts rotate-key                         # new RS256 key signs from now on; old keys stay in JWKS
bun vitest run                                    # PGlite; set SHIM_TEST_DATABASE_URL to use real Postgres
bun dev/fake-oidc.ts                              # dev IdP: OIDC_ISSUER=http://127.0.0.1:8721/realms/dev, secret dev-secret
```

| Env                                                                  | Meaning                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHIM_PORT` (8720), `SHIM_HOST` (127.0.0.1)                          | bind address                                                                                                                                                                                        |
| `SHIM_PUBLIC_ORIGIN`                                                 | public URL; token `iss`, device `verification_uri`, Keycloak callback `<origin>/user_management/callback`                                                                                           |
| `SHIM_DATABASE_URL`                                                  | Postgres                                                                                                                                                                                            |
| `SHIM_API_KEY`                                                       | the API's `WORKOS_API_KEY`; Bearer for directory endpoints, accepted as `client_secret`                                                                                                             |
| `SHIM_CLIENT_ID`                                                     | the clients' `WORKOS_CLIENT_ID`                                                                                                                                                                     |
| `SHIM_ALLOWED_REDIRECT_URIS`                                         | comma list, exact match on authorize; their origins are the allowed logout `return_to` targets                                                                                                      |
| `SHIM_AUTH_MODE` (oidc)                                              | `oidc` or `tailscale`, see above                                                                                                                                                                    |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | upstream IdP (discovery); oidc mode only                                                                                                                                                            |
| `SHIM_ALLOWED_EMAIL_DOMAINS`, `SHIM_REQUIRED_GROUP`                  | login policy (verified email required); the group check needs oidc mode                                                                                                                             |
| `SHIM_ADMIN_EMAILS`                                                  | get role `admin` in the default org at every login                                                                                                                                                  |
| `SHIM_DEFAULT_ORG_ID`                                                | every user joins this org on first login                                                                                                                                                            |
| `ACCESS_TOKEN_TTL_SECONDS` (3600)                                    | access token lifetime                                                                                                                                                                               |
| `SHIM_OIDC_LOGOUT` (false)                                           | oidc mode: `true` also ends the Keycloak SSO session on logout (signs out of every realm app). Default: revoke the shim session and redirect to `return_to`, or `SHIM_PUBLIC_ORIGIN` if not allowed |
