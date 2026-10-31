# Imposter — Cloudflare V1

A first playable multiplayer version of Imposter. The project is designed to be deployed as **one Cloudflare Worker** with Static Assets for the website and a SQLite-backed Durable Object for each game room.

## What is included

- Mobile-friendly browser game UI.
- Create a room and join with a six-character code or invite link.
- 3–12 players per room.
- 21 selectable topics backed by the 2,000-word dataset.
- 1–3 imposters, with an optional category hint.
- Private role and word reveal per player.
- Ready check, one-word clue round, voting, tie-break, final guess and results.
- Room updates over WebSockets, with polling as a fallback.
- Durable room state stored by Cloudflare Durable Objects.
- The secret word bank is bundled into the Worker and is not exposed through the public topics API.

## Important: repository layout

All of these must be at the **root** of your GitHub repository. In particular, `package.json` must be at the same level as `wrangler.jsonc`, not inside an extra nested `imposter-the-game-v1/` folder.

```text
imposter-the-game/
├── package.json
├── wrangler.jsonc
├── README.md
├── data/
│   └── wordbank.json
├── src/
│   ├── index.js
│   └── wordbank.js
└── public/
    ├── index.html
    ├── app.js
    └── styles.css
```

## Cloudflare Workers Builds settings

On the Cloudflare screen where the connected GitHub repository is selected, use:

| Setting | Value |
|---|---|
| Project name | `imposter-the-game` |
| Root directory | Leave blank (repository root) |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` |
| Preview builds | On (optional) |

Do **not** use `npx wrangler login` as the preview command. `wrangler login` is an interactive local-machine authentication command. Do not use `npx wrangler dev` as the CI preview command; that starts a local development server. Cloudflare Workers Builds uses `wrangler preview` for preview deployments.

## Deploy

1. Download and extract this project ZIP.
2. Upload the **contents** of the extracted folder to the root of `Abhiram-p/imposter-the-game` on GitHub. Do not upload only the ZIP, and do not leave all files inside an extra nested folder.
3. Commit the changes to the repository's production branch (usually `main`).
4. In Cloudflare Workers Builds, set the commands in the table above and deploy, or push the commit to trigger the connected deployment.
5. When the build completes, open the `*.workers.dev` URL shown by Cloudflare. The game homepage should load.

## Run locally (optional)

Requires Node.js 20 or later.

```bash
npm install
npx wrangler dev
```

Wrangler will ask you to log in if you are not already authenticated. Local Durable Object data is stored in the local Wrangler development state.

## Useful endpoints

- `GET /api/health` — health check.
- `GET /api/topics` — topic names and word counts (not the secret words).
- `POST /api/rooms` — create a room; JSON body: `{ "hostName": "Name" }`.
- `POST /api/rooms/:code/join` — join a lobby; JSON body: `{ "name": "Name" }`.

## Cloudflare architecture

- **Workers Static Assets** serves `public/`.
- **Worker** in `src/index.js` handles API requests.
- **Durable Object** `GameRoom` owns each room and its SQLite-backed persistent state.
- `data/wordbank.json` and `src/wordbank.js` are deployed with the Worker code, not in the public assets directory.

No Pages project is required for this single-deployment setup. It avoids splitting the website and game API into separate Cloudflare projects during the first release.

## V1 limitations

- Players enter their names without accounts; a per-browser session token identifies each player in a room.
- Rooms are intended for casual sessions and expire after 24 hours of inactivity once a game has started.
- The clue round is simultaneous rather than a strict clockwise turn sequence.
- If there is a vote tie, the host chooses among tied players.
- The server validates game actions and keeps the selected word and imposter identities out of the public room state until the game ends.
