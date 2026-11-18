# Pollen

A slow, friendly flower-breeding garden built on [Serble](https://serble.net). It is an unofficial community app.

- **Grow:** sign in with Serble and plant seeds. They sprout, bud and bloom in real time, and watering speeds them up.
- **Breed:** cross-pollinate two blooms to make a hybrid seed. Colours blend, forms mix, and rare traits (luminous, opaline, midnight, starbloom…) can be passed on or appear as mutations.
- **Collect:** the first gardener to grow each species is credited in the public Almanac.
- **Trade:** any bloom can be sent to your Serble inventory as a real item, then sold or swapped on the Serble Market. Whoever holds that item can bring it back into their own garden to breed from.

Every flower is generated procedurally from a small genome (`shared/genome.ts`) and drawn as SVG.

## How it uses Serble

| Feature | Serble API |
| --- | --- |
| Sign-in | Legacy OAuth (`/oauth/authorize` on the website, then `/api/v1/oauth/token/refresh2` and `access2`), scopes `user_info economy`. Pollen uses this instead of OIDC because Serble's OIDC access tokens only work for userinfo. |
| Seed packets | A transaction proposal in which the user pays the app |
| Sending a bloom to Serble | `POST /api/v1/items` mints an item owned by the app, then a proposal offers it to the user. The same item is reused if the bloom comes back and goes out again |
| Bringing a bloom home | `GET /api/v1/inventory?creatorApp=…` with the user's token, then a proposal that requests the items |
| Coin balance | `GET /api/v1/balance` with the user's token |

Proposals are settled when the user returns to `/return` and also by a background poller, so closing the tab does not lose anything. Each proposal's effect is applied once.

## Running locally

```bash
npm install
npm run build
MOCK_SERBLE=1 GROW_SCALE=0.01 npm start   # http://localhost:8080, with an in-memory fake Serble
```

`MOCK_SERBLE=1` mounts a fake Serble under `/__mock`. It provides sign-in, items, proposals and a consent page, so the whole game can be played offline. `GROW_SCALE` speeds up growth.

Tests:

```bash
npm test                     # unit tests
node test/flow.mjs           # end-to-end, against a server started with MOCK_SERBLE=1 GROW_SCALE=0.001 PORT=8090
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8080` | Public origin. `PUBLIC_URL/auth/callback` must be registered as a redirect URI on the Serble app |
| `SERBLE_CLIENT_ID` / `SERBLE_CLIENT_SECRET` | | The Serble OAuth app |
| `SERBLE_API_KEY` | | An API key for that app |
| `SESSION_SECRET` | random | Signs session cookies. Set it, or sessions end on restart |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database |
| `SEED_PACK_PRICE` / `SEED_PACK_SIZE` / `SEED_PACK_LUCK` | `10` / `3` / `3` | Packet price in coins, seeds per packet, rare-trait multiplier |
| `EXPORT_FEE` | `1` | Coins charged to send a bloom to Serble |
| `FREE_SEED_HOURS` / `FREE_SEED_CAP` | `8` / `3` | Free seed rate |
| `PLOTS` | `6` | Garden size |
| `ADMIN_USERS` | | Serble usernames allowed to read `/api/admin/overview` |
| `GROW_SCALE` | `1` | Growth-time multiplier |

## Deploying

Live at **https://pollinate.garden**.

CI tests every push and publishes `ghcr.io/copokbl/pollen:latest` and `:sha-…` from `main`. After the image passes smoke tests on amd64 and arm64, a deploy job joins the owner's tailnet with an ephemeral Tailscale key and tells Komodo to redeploy. That job needs the `TS_AUTHKEY`, `KOMODO_URL`, `KOMODO_API_KEY` and `KOMODO_API_SECRET` secrets, plus an optional `KOMODO_TARGET` variable (`deployment:<name>` or `stack:<name>`, default `deployment:pollen`). Without them, production updates on Komodo's own poll. The image is a single container listening on `8080` that keeps its data in a volume at `/data`. See `compose.yaml`.
