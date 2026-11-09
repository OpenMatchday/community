# Open Matchday -- community

Google sign-in contribution service, validation, moderation, and GitHub App PR creation.

Part of the [OpenMatchday](https://github.com/OpenMatchday) organization.

## Spike D7 (OM-008)

Provisional stack (see `docs` spike `d7-community-backend.md`):

- **Host:** Vercel Functions (Hono)
- **DB:** Neon Postgres via Vercel Marketplace (credentials injected as `DATABASE_URL`)
- **Secret store:** Vercel project Environment Variables with type Secret (encrypted at rest)

Local check:

```bash
npm ci
npm run check
```

Non-production endpoints: `/health`, `/spike/secret-read`, `/spike/auth-stub`, `/spike/db-presence`.

## License

MIT. See [LICENSE](LICENSE).
