# Imposter — Cloudflare V1

A multiplayer word game with online rooms, offline pass-the-phone play, adjustable clue rounds, and Discord Activity integration (v1.3.0). The project is designed to be deployed as **one Cloudflare Worker** with Static Assets for the website and a SQLite-backed Durable Object for each game room.

## What is included

- Mobile-friendly browser game UI.
- Create a room and join with a six-character code or invite link.
- 3–12 players per room.
- 21 selectable topics backed by the 2,000-word dataset.
- 1–3 imposters, with an optional category hint.
- Host-configurable 3–10 clue rounds (minimum 3); every player submits one clue per round before the vote unlocks.
- Private role and word reveal per player.
- Offline pass-the-phone mode: add names, then press-and-hold to privately reveal each role.
- Offline clue-round progression and private pass-the-phone voting before the final reveal.
- End-of-round reveal showing the secret word and all Imposters.
- Service-worker cache for the app shell and word bank, allowing offline local games after the first successful online visit.
- Imposter category hints are checked server-side and suppressed if they exactly match the secret word (case-insensitive and Unicode-normalized).
- Ready check, one-word clue round, voting, tie-break, final guess and results.
- Room updates over WebSockets, with polling as a fallback.
- Discord Activity support using the official Embedded App SDK, Discord OAuth code exchange on the Worker, and Discord identity prefill.
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
│   ├── wordbank.json
│   ├── wordbank.csv
│   └── wordbank.txt
├── src/
│   ├── index.js
│   ├── wordbank.js
│   └── discord-sdk-entry.js
├── tests/
│   └── game-logic.test.js
└── public/
    ├── index.html
    ├── app.js
    ├── styles.css
    ├── sw.js
    ├── wordbank.json
    └── discord-sdk.js
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
npm test
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
- **Durable Object** `ActivitySession` maps a Discord Activity `instanceId` and verified Discord user IDs onto the shared game room.
- `data/wordbank.json` and `src/wordbank.js` are deployed with the Worker code, not in the public assets directory.

No Pages project is required for this single-deployment setup. It avoids splitting the website and game API into separate Cloudflare projects during the first release.

## V1.3 — Automatic Discord Activity rooms

- The host chooses 3–10 clue rounds. The backend rejects values below 3 or above 10.
- Each player submits one one-word clue per round. The current round advances only after every player has submitted a clue. Voting remains locked until all configured rounds are complete.
- Online voting uses the existing private player vote and tie-break / final-guess flow. The result screen groups clues by round.
- Offline mode uses a host-controlled round advance after the group finishes each spoken clue round, then passes the phone privately to each voter. The final vote tally is shown before the host reveals the word and Imposter identities.
- `npm install` runs a postinstall build that bundles `@discord/embedded-app-sdk` into `public/discord-sdk.js`; the bundle is served from the same Worker origin and does not rely on a CDN at runtime.
- Inside a Discord Activity, the app authenticates through the Embedded App SDK and automatically enters a shared room keyed to Discord's Activity `instance_id`.
- The Worker verifies each OAuth access token with Discord's `/users/@me` endpoint before accepting the identity. The client cannot choose another user's Discord ID or display name. The SDK's `instanceId` is the room key; Discord documents that participants joining the same Activity instance receive the same ID.
- A SQLite-backed `ActivitySession` Durable Object creates one room for the Activity instance and idempotently maps each Discord user to one game player. Reopening the Activity returns the same player session instead of duplicating the player.
- Friends who open the same Activity instance are added to the same lobby automatically; no six-character room code is needed inside Discord. Regular web rooms and pass-the-phone offline mode remain available outside Discord.
- The lobby can open Discord's native channel invite dialog. The Activity uses the same round, clue, vote, tie-break, final-guess and result flow as web multiplayer.

### Discord Activity setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Installation**, enable both **Guild Install** and **User Install** contexts.
3. Under **OAuth2**, add `https://127.0.0.1` as a placeholder Redirect URI and save. Discord's Embedded App SDK handles returning to the Activity during its authorization flow.
4. Copy the application's **Client ID** into `DISCORD_CLIENT_ID` in `wrangler.jsonc`, replacing `YOUR_DISCORD_APPLICATION_CLIENT_ID`. The Client ID is public; do not put the Client Secret in the repository.
5. In Cloudflare, open the `imposter-the-game` Worker → **Settings → Variables and Secrets**. Add `DISCORD_CLIENT_SECRET` as an encrypted **Secret** and deploy again. Never commit this secret to GitHub.
6. In the Discord Developer Portal, open **Activities → URL Mappings**. Add prefix `/` mapped to the Worker hostname, for example `imposter-the-game.<your-subdomain>.workers.dev` (omit `https://`). This root mapping routes the Activity page and its `/api/*` requests through Discord's proxy.
7. Under **Activities → Settings**, enable Activities. Discord creates a default **Launch** Entry Point command.
8. Enable Developer Mode in your Discord client, join a test voice channel, open the Activity Shelf and launch the app. The first launch completes Discord authorization and automatically creates or joins that Activity instance's shared room.

The Discord Activity integration is implemented in the project, but it is not registered, enabled, or published on your Discord account automatically. You must complete the Developer Portal and Cloudflare configuration above and test it from a Discord developer account. Every person who launches the same Activity instance is automatically placed in that instance's shared game room. An Activity instance has its own room; launching the game separately creates a separate room. During development, unverified Activities are restricted to the app's developer team. Public discovery/distribution may require Discord's review and compliance steps.

## V1 limitations

- Players enter their names without accounts; a per-browser session token identifies each player in a room.
- Rooms are intended for casual sessions and expire after 24 hours of inactivity once a game has started.
- Online clue entry is simultaneous within each configured round rather than a strict clockwise turn sequence. Offline round advancement is controlled by the host.
- If there is a vote tie, the host chooses among tied players.
- The server validates game actions and keeps the selected word and imposter identities out of the public room state until the game ends.


## V1.1 — Offline pass-the-phone mode

1. Open the game once while connected to the internet. The service worker caches the app shell and `public/wordbank.json`.
2. Choose **Play offline · Pass the phone** on the home screen.
3. Add 3–12 player names, select topics and choose the number of Imposters.
4. Deal roles. Pass the phone to each named player in turn.
5. Each player presses and holds **Press & hold to reveal role**. The role is hidden as soon as they release the button. They then pass the phone to the next player.
6. Once everyone has viewed their role, put the phone aside and play in person.
7. At the end, the host taps **End round & reveal word and Imposter** to reveal the secret word and Imposter identities.

The local mode makes no API calls and requires no room code. It works offline after the app and word bank have been cached by a successful online visit. Browser storage can be cleared by the user or the browser, so it is sensible to open the app online before going somewhere without connectivity.

The word bank must be downloaded to the browser for offline play, so its topic and word lists are not a security boundary. The chosen secret word and Imposter identities are only shown in the local device's role reveal and end-of-round result.


### Updating from v1.2.0

Upload the contents of this release ZIP to the root of the existing GitHub repository and commit to `main`. Keep the Cloudflare Worker build command as `npm install` and deploy command as `npx wrangler deploy`. The `postinstall` lifecycle bundles the Discord SDK during the `npm install` build step. This release adds a new SQLite-backed `ActivitySession` Durable Object namespace, declared through Wrangler's `exports` configuration. Cloudflare will provision this new namespace on deployment; the existing `GameRoom` namespace remains in place.

The Discord integration remains optional for ordinary web play. If you have not configured a Discord Client ID and Client Secret, the main website and online/offline modes continue to work normally.
