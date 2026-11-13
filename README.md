# Open Matchday -- community

Google sign-in contribution service, validation, image pipeline, submission queue, and GitHub App PR creation into `teams`.

Part of the [OpenMatchday](https://github.com/OpenMatchday) organization.

## Stack (D7)

- **Host:** Vercel Functions (Hono)
- **DB:** Neon Postgres via Vercel Marketplace (`DATABASE_URL`)
- **Secret store:** Vercel Environment Variable Secrets
- **Auth:** Google OAuth 2.0 / OpenID Connect server flow
- **PRs:** GitHub App installation tokens (short-lived) against `OpenMatchday/teams`

Sources: [Google OIDC](https://developers.google.com/identity/protocols/oauth2/openid-connect), [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [Vercel Functions](https://vercel.com/docs/functions), [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness; `google_oidc_configured`, `github_app_configured` |
| GET | `/v1/auth/google/start` | OIDC authorize redirect |
| GET | `/v1/auth/google/callback` | Code exchange + session cookie |
| GET | `/v1/auth/session` | Signed-in flag (no Google email) |
| POST | `/v1/auth/logout` | Clear session |
| POST | `/v1/wizard/validate` | Server-side draft validation |
| POST | `/v1/wizard/preview` | Exact public preview JSON |
| POST | `/v1/wizard/submit` | Idempotent queue; opens PR when GitHub App configured |
| POST | `/v1/images` | Multipart upload; re-encode; strip EXIF; reject SVG/URLs |
| GET | `/v1/submissions/:id` | Status: queued, pr_opened, changes_requested, merged, rejected |
| POST | `/v1/submissions/:id/open-pr` | Retry PR open (authenticated owner of submission) |

Google email is stored as SHA-256 only and never returned. Commits use the GitHub App bot noreply identity. PR bodies credit the chosen handle only.

## AC-10.6 guarantees

- Short-lived installation tokens scoped to `teams` (`contents` + `pull_requests` write)
- Branch `community/contrib-*` only; never push `main`; never call merge
- Registry path allowlist under `packages/` (see `teams/docs/contribution-paths.md`)
- No fabricated personal author emails; no Google email in commits or PR bodies

## Local checks

```bash
npm ci
npm run typecheck
npm test
npm run check
```

`OM_AUTH_TEST_MODE=1` enables `POST /v1/auth/test-login` for non-production self-checks. Do not set it on Vercel production.

## Owner setup

### Google sign-in

1. Create an OAuth 2.0 Client ID (Web application) in Google Cloud Console.
2. Add authorized redirect URI matching `GOOGLE_REDIRECT_URI`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` as Vercel Secrets.

### GitHub App PRs

Follow [../.github/community-github-app.md](../.github/community-github-app.md) (sibling repo `.github` on GitHub: `OpenMatchday/.github`). Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`.

Redeploy. Confirm `GET /health` reports both `google_oidc_configured` and `github_app_configured` as needed.

## License

MIT. See [LICENSE](LICENSE).
