# Open Matchday -- community

Google sign-in contribution service, validation, image pipeline, submission queue, and (later) GitHub App PR creation.

Part of the [OpenMatchday](https://github.com/OpenMatchday) organization.

## Stack (D7)

- **Host:** Vercel Functions (Hono)
- **DB:** Neon Postgres via Vercel Marketplace (`DATABASE_URL`)
- **Secret store:** Vercel Environment Variable Secrets
- **Auth:** Google OAuth 2.0 / OpenID Connect server flow

Sources: [Google OIDC](https://developers.google.com/identity/protocols/oauth2/openid-connect), [Vercel Functions](https://vercel.com/docs/functions), [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono).

## API (OM-040)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/v1/auth/google/start` | OIDC authorize redirect |
| GET | `/v1/auth/google/callback` | Code exchange + session cookie |
| GET | `/v1/auth/session` | Signed-in flag (no Google email) |
| POST | `/v1/auth/logout` | Clear session |
| POST | `/v1/wizard/validate` | Server-side draft validation |
| POST | `/v1/wizard/preview` | Exact public preview JSON |
| POST | `/v1/wizard/submit` | Idempotent queue (`status=queued`) |
| POST | `/v1/images` | Multipart upload; re-encode; strip EXIF; reject SVG/URLs |
| GET | `/v1/submissions/:id` | Status: queued, pr_opened, changes_requested, merged, rejected |

Google email is stored as SHA-256 only and never returned in API responses. PR creation is OM-041.

## Local checks

```bash
npm ci
npm run typecheck
npm test
npm run check
```

`OM_AUTH_TEST_MODE=1` enables `POST /v1/auth/test-login` for non-production self-checks. Do not set it on Vercel production.

## Owner setup (live Google sign-in)

1. Create an OAuth 2.0 Client ID (Web application) in Google Cloud Console.
2. Add authorized redirect URI matching `GOOGLE_REDIRECT_URI`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` as Vercel Secrets on `open-matchday-community`.
4. Redeploy. Confirm `GET /health` reports `google_oidc_configured: true`.

## License

MIT. See [LICENSE](LICENSE).
