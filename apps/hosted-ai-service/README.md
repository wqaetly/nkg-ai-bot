# NKG Hosted AI Service

The app-facing commerce, model-proxy and default-search boundary for NKG AI. It is intentionally separate from New API: New API routes model traffic, while this service owns Apple purchase verification, the append-only point ledger, run reservations and settlement. Authenticated app sessions can also call `/api/app/v1/search`; the SearXNG key never reaches the client.

See [`../../docs/architecture/hosted-ai-points.md`](../../docs/architecture/hosted-ai-points.md) for the trust model and [`../../docs/app-store-points-release-checklist.md`](../../docs/app-store-points-release-checklist.md) for release gates.

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

## VPS deployment

1. Create consumable products in App Store Connect and copy their exact IDs into `NKG_POINT_PACKS_JSON`.
2. Download the current Apple Root CA certificates from Apple PKI as DER `.cer` files into `certs/`.
3. Copy `.env.example` to `.env`, replace every secret and configure the numeric Apple app ID.
4. Create a dedicated, model-restricted New API token for this service. Do not reuse an administrator token.
5. Configure `SEARXNG_BASE_URL` and a search-only `SEARXNG_API_KEY`; apply an additional IP rate limit at Nginx/SearXNG.
6. Run `docker compose up -d --build`.
7. Put `nginx-location.conf` before the existing New API catch-all route for `api.lfzxb.top`.
8. Configure App Store Server Notifications V2 to post to `https://api.lfzxb.top/api/app/v1/apple/notifications`.

The service automatically applies SQL migrations during startup. Back up the `nkg-commerce-db` volume before upgrades. Keep `NKG_WELCOME_GRANT_POINTS=0` until device-attestation or equivalent anti-abuse controls are deployed.

## Required security properties

- Only the commerce service knows `NEW_API_KEY`; the app receives a signed, short-lived workflow-run key.
- Only this service knows `SEARXNG_API_KEY`; default search requires a valid anonymous app session and is rate-limited independently from model runs.
- One workflow authorization may cover multiple model requests, but every request has its own settlement row and cumulative charges cannot exceed the run reservation.
- Once an upstream success has begun, missing usage, a broken stream, or a service restart fails closed against the remaining reservation.
- Apple transaction IDs and ledger references have database uniqueness constraints.
- Permanent consumable balances can be recovered after reinstall with a 256-bit recovery code; only its hash is stored server-side.
- StoreKit transactions are only finished by the app after this service confirms credit.
- Refund notifications create tombstones even when the original purchase has not yet been redeemed, preventing later replay credit.
- `/healthz` is liveness-only; container health checks use `/readyz`, which verifies PostgreSQL connectivity.
