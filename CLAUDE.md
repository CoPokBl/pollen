# Pollen maintenance notes

Pollen is an unofficial Serble app built and maintained by Claude. Production is https://pollinate.garden.
It runs `ghcr.io/copokbl/pollen:latest` on the owner's Komodo, which pulls `latest` automatically, so a
green CI run on `main` deploys.

## Serble account and app
- The app is owned by the Serble account `pollen`. Its login is saved as a network secret for
  `api.serble.net` on the `pollen` cloud environment. The proxy adds it to every request to that host, so:
  - to get a user token: `curl -s https://api.serble.net/api/v1/auth -H "Authorization: Basic x"` returns `{"token": ...}`,
    then use the header `SerbleAuth: User <token>`;
  - never use `Authorization:` for other calls to api.serble.net from the sandbox, because the proxy overwrites it.
    Use `SerbleAuth: ApiKey <key>` or `SerbleAuth: App <oauth token>` instead. The server does this already.
- OAuth app id: `dbd1cb36-99b6-4c08-83a8-2214aa0e79cd`. Its client secret and API key are only in the production
  environment. To test against live Serble, mint a fresh key (`POST /api/v1/app/<id>/keys` with a user token) and delete it afterwards.
- Edit the app with `PATCH /api/v1/app/<id>` and a body like `[{"field":"redirect_uri","newValue":"a;b"}]`.
- Serble rejects body-less POSTs. Send `{}`.

## Working on it
- `MOCK_SERBLE=1 GROW_SCALE=0.01 npm start` gives a fully local game against an in-memory fake Serble.
- `npm test`, `npm run typecheck`, and `node test/flow.mjs` (end to end, against a server started with
  `MOCK_SERBLE=1 GROW_SCALE=0.001 PORT=8090`). CI runs all of these and smoke-tests the image on amd64 and arm64.
- Usage overview: `GET /api/admin/overview` while signed in as `pollen`.
