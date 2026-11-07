# @humanlayer/workos-shim

A small WorkOS-compatible server for self-hosting. It speaks the parts of the WorkOS REST API that the
riptide API, AuthKit-JS, the CLI and the plugins use, and it delegates sign-in to an OIDC provider
(Keycloak) as a confidential client. State lives in Postgres schema `workos_shim`; migrations run at startup.

```sh
bun src/main.ts                                   # serve
bun src/cli.ts seed --org-name Neara --riptide-database-url postgres://...   # prints SHIM_DEFAULT_ORG_ID=org_...
bun src/cli.ts rotate-key                         # new RS256 key signs from now on; old keys stay in JWKS
bun vitest run                                    # PGlite; set SHIM_TEST_DATABASE_URL to use real Postgres
bun dev/fake-oidc.ts                              # dev IdP: OIDC_ISSUER=http://127.0.0.1:8721/realms/dev, secret dev-secret
```

| Env                                                                  | Meaning                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SHIM_PORT` (8720), `SHIM_HOST` (127.0.0.1)                          | bind address                                                                                              |
| `SHIM_PUBLIC_ORIGIN`                                                 | public URL; token `iss`, device `verification_uri`, Keycloak callback `<origin>/user_management/callback` |
| `SHIM_DATABASE_URL`                                                  | Postgres                                                                                                  |
| `SHIM_API_KEY`                                                       | the API's `WORKOS_API_KEY`; Bearer for directory endpoints, accepted as `client_secret`                   |
| `SHIM_CLIENT_ID`                                                     | the clients' `WORKOS_CLIENT_ID`                                                                           |
| `SHIM_ALLOWED_REDIRECT_URIS`                                         | comma list, exact match on authorize; their origins are the allowed logout `return_to` targets            |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | upstream IdP (discovery)                                                                                  |
| `SHIM_ALLOWED_EMAIL_DOMAINS`, `SHIM_REQUIRED_GROUP`                  | login policy (verified email required)                                                                    |
| `SHIM_ADMIN_EMAILS`                                                  | get role `admin` in the default org at every login                                                        |
| `SHIM_DEFAULT_ORG_ID`                                                | every user joins this org on first login                                                                  |
| `ACCESS_TOKEN_TTL_SECONDS` (3600)                                    | access token lifetime                                                                                     |
