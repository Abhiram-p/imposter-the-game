import { WORD_BANK } from "./wordbank.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 12;
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 10;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extraHeaders
    }
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function randomString(length = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 18) : "";
}

function normalizeCode(value) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) : "";
}

function topicList() {
  return WORD_BANK.topics.map(({ id, name, description, wordCount }) => ({ id, name, description, wordCount }));
}

function validRoundCount(value) {
  const rounds = Number(value ?? MIN_ROUNDS);
  return Number.isInteger(rounds) && rounds >= MIN_ROUNDS && rounds <= MAX_ROUNDS ? rounds : null;
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, app: "imposter-the-game", version: "1.3.0" });
    }

    if (url.pathname === "/api/topics" && request.method === "GET") {
      return json({ topics: topicList(), wordCount: WORD_BANK.wordCount });
    }

    if (url.pathname === "/api/discord/config" && request.method === "GET") {
      const clientId = String(env.DISCORD_CLIENT_ID || "").trim();
      return json({ enabled: Boolean(clientId && clientId !== "YOUR_DISCORD_APPLICATION_CLIENT_ID"), clientId });
    }

    if (url.pathname === "/api/discord/token" && request.method === "POST") {
      const body = await readJson(request);
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      const clientId = String(env.DISCORD_CLIENT_ID || "").trim();
      const clientSecret = String(env.DISCORD_CLIENT_SECRET || "").trim();
      if (!clientId || !clientSecret) return error("Discord Activity authentication is not configured yet.", 503);
      if (!code || code.length > 1024) return error("A valid Discord authorization code is required.");
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code
        })
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.access_token) {
        return error(tokenData.error_description || "Discord authorization could not be completed.", 502);
      }
      return json({ access_token: tokenData.access_token, token_type: tokenData.token_type || "Bearer" });
    }

    if (url.pathname === "/api/discord/enter" && request.method === "POST") {
      const body = await readJson(request) || {};
      const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim() : "";
      const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) return error("Discord did not provide a valid Activity instance ID.");
      if (!accessToken || accessToken.length > 4096) return error("Discord authentication is required to join this Activity.", 401);
      if (!env.ACTIVITY_SESSIONS) return error("Discord Activity sessions are not configured. Deploy the latest Worker first.", 503);

      // Verify the SDK-issued OAuth token with Discord. Never trust a user ID or name sent by the browser.
      const identityResponse = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" }
      });
      const identity = await identityResponse.json().catch(() => ({}));
      if (!identityResponse.ok || !identity.id) return error("Discord authentication expired. Reopen the Activity to reconnect.", 401);

      const sessionId = env.ACTIVITY_SESSIONS.idFromName(`${String(env.DISCORD_CLIENT_ID || "app")}:${instanceId}`);
      const session = env.ACTIVITY_SESSIONS.get(sessionId);
      return session.fetch("https://activity/enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discordUserId: String(identity.id),
          name: normalizeName(identity.global_name || identity.username || "Discord Player")
        })
      });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = await readJson(request);
      const hostName = normalizeName(body?.hostName);
      if (!hostName) return error("Enter a player name.");

      let code = randomCode();
      // A room code collision is exceptionally unlikely; try a few fresh codes.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = env.GAME_ROOMS.idFromName(code);
        const stub = env.GAME_ROOMS.get(id);
        const response = await stub.fetch("https://room/init", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-room-code": code },
          body: JSON.stringify({ hostName })
        });
        if (response.status !== 409) return response;
        code = randomCode();
      }
      return error("Could not create a room. Please try again.", 503);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|state|me|ws|start|ready|clue|vote|tie-break|guess|reset))?$/i);
    if (!match) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return error("Not found.", 404);
    }

    const code = normalizeCode(match[1]);
    const action = (match[2] || "state").toLowerCase();
    if (code.length !== 6) return error("Invalid room code.", 400);

    const id = env.GAME_ROOMS.idFromName(code);
    const stub = env.GAME_ROOMS.get(id);

    if (action === "ws") {
      const target = new URL("https://room/ws");
      target.search = url.search;
      return stub.fetch(new Request(target, request));
    }

    const target = new URL(`https://room/${action}`);
    target.search = url.search;
    return stub.fetch(new Request(target, request));
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async loadRoom() {
    const room = await this.ctx.storage.get("room");
    if (!room) return null;
    room.settings ||= { topics: WORD_BANK.topics.map((topic) => topic.id), imposterCount: 1, imposterHint: true, rounds: MIN_ROUNDS };
    if (!Number.isInteger(room.settings.rounds)) room.settings.rounds = MIN_ROUNDS;
    if (!Array.isArray(room.roundClues)) {
      room.roundClues = [room.clues || {}];
      room.currentRound = 1;
    }
    if (!Number.isInteger(room.currentRound)) room.currentRound = 1;
    if (Date.now() - room.updatedAt > ROOM_TTL_MS && room.phase !== "lobby") {
      await this.ctx.storage.deleteAll();
      return null;
    }
    return room;
  }

  async saveRoom(room) {
    room.updatedAt = Date.now();
    await this.ctx.storage.put("room", room);
  }

  playerForToken(room, token) {
    if (!token || typeof token !== "string") return null;
    return room.players.find((player) => player.token === token) || null;
  }

  publicState(room) {
    const playerNames = new Map(room.players.map((player) => [player.id, player.name]));
    const currentClues = room.roundClues?.[Math.max(0, (room.currentRound || 1) - 1)] || room.clues || {};
    const allClues = (room.roundClues || [room.clues || {}]).flatMap((round, index) =>
      Object.entries(round || {}).map(([playerId, text]) => ({
        round: index + 1,
        playerId,
        playerName: playerNames.get(playerId) || "Player",
        text
      }))
    );
    const output = {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map(({ id, name, isHost, ready, online }) => ({ id, name, isHost, ready, online })),
      settings: room.settings,
      currentRound: room.currentRound || 1,
      totalRounds: room.settings.rounds || MIN_ROUNDS,
      clues: Object.entries(currentClues).map(([playerId, text]) => ({ playerId, playerName: playerNames.get(playerId) || "Player", text })),
      allClues,
      clueCount: Object.keys(currentClues).length,
      voteCount: Object.keys(room.votes || {}).length,
      playerCount: room.players.length,
      accusedPlayer: room.accusedPlayerId ? { id: room.accusedPlayerId, name: playerNames.get(room.accusedPlayerId) || "Player" } : null,
      tiedPlayers: (room.tiedPlayerIds || []).map((id) => ({ id, name: playerNames.get(id) || "Player" })),
      winner: room.winner || null
    };

    if (room.phase === "finished") {
      output.result = {
        word: room.secretWord,
        category: room.categoryName,
        imposters: room.imposterIds.map((id) => ({ id, name: playerNames.get(id) || "Player" })),
        winner: room.winner,
        votes: Object.entries(room.votes).map(([voterId, targetId]) => ({
          voterName: playerNames.get(voterId) || "Player",
          targetName: playerNames.get(targetId) || "Player"
        })),
        clues: allClues
      };
    }
    return output;
  }

  privateState(room, player) {
    const isImposter = room.imposterIds.includes(player.id);
    const currentClues = room.roundClues?.[Math.max(0, (room.currentRound || 1) - 1)] || room.clues || {};
    return {
      player: { id: player.id, name: player.name, isHost: player.isHost },
      phase: room.phase,
      role: room.phase === "lobby" ? null : (isImposter ? "imposter" : "civilian"),
      word: room.phase === "lobby" || isImposter ? null : room.secretWord,
      category: room.phase === "lobby" ? null : room.categoryName,
      hint: room.phase !== "lobby" && isImposter && room.settings.imposterHint
        && String(room.categoryName || "").normalize("NFKC").trim().toLocaleLowerCase()
          !== String(room.secretWord || "").normalize("NFKC").trim().toLocaleLowerCase()
        ? room.categoryName : null,
      ready: Boolean(player.ready),
      hasClue: Boolean(currentClues[player.id]),
      clue: currentClues[player.id] || null,
      hasVoted: Object.prototype.hasOwnProperty.call(room.votes, player.id),
      isAccused: room.accusedPlayerId === player.id,
      canGuess: room.phase === "final_guess" && room.accusedPlayerId === player.id && isImposter
    };
  }

  async broadcast(room) {
    const message = JSON.stringify({ type: "room:update", state: this.publicState(room) });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { /* disconnected sockets are cleaned up by Cloudflare */ }
    }
  }

  async ensureHost(room, token) {
    const player = this.playerForToken(room, token);
    if (!player || !player.isHost) return null;
    return player;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") return this.handleWebSocket(request, url);

    if (path === "/init" && request.method === "POST") {
      if (await this.loadRoom()) return error("Room code already exists.", 409);
      const body = await readJson(request);
      const hostName = normalizeName(body?.hostName);
      if (!hostName) return error("Enter a player name.");
      const host = { id: `p_${randomString(6)}`, name: hostName, token: randomString(), isHost: true, ready: false, online: true };
      const room = {
        code: this.ctx.id.name || "",
        phase: "lobby",
        hostId: host.id,
        players: [host],
        settings: { topics: WORD_BANK.topics.map((topic) => topic.id), imposterCount: 1, imposterHint: true, rounds: MIN_ROUNDS },
        secretWord: null,
        categoryId: null,
        categoryName: null,
        imposterIds: [],
        clues: {},
        votes: {},
        accusedPlayerId: null,
        tiedPlayerIds: [],
        winner: null,
        updatedAt: Date.now()
      };
      // idFromName(code) stores the code in the deterministic object ID; keep a copy from the caller header when available.
      room.code = request.headers.get("x-room-code") || room.code;
      await this.saveRoom(room);
      return json({ code: room.code, token: host.token, player: { id: host.id, name: host.name, isHost: true }, state: this.publicState(room) }, 201);
    }

    const room = await this.loadRoom();
    if (!room) return error("Room not found or expired.", 404);

    if (path === "/join" && request.method === "POST") {
      if (room.phase !== "lobby") return error("This game has already started.", 409);
      if (room.players.length >= MAX_PLAYERS) return error(`This room is full (maximum ${MAX_PLAYERS} players).`, 409);
      const body = await readJson(request);
      const name = normalizeName(body?.name);
      if (!name) return error("Enter a player name.");
      if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return error("That name is already taken in this room.", 409);
      const player = { id: `p_${randomString(6)}`, name, token: randomString(), isHost: false, ready: false, online: true };
      room.players.push(player);
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ code: room.code, token: player.token, player: { id: player.id, name: player.name, isHost: false }, state: this.publicState(room) }, 201);
    }

    const token = url.searchParams.get("token");
    const player = this.playerForToken(room, token);

    if (path === "/state" && request.method === "GET") {
      if (!player) return error("Your player session is not valid. Rejoin the room.", 401);
      return json({ state: this.publicState(room) });
    }

    if (path === "/me" && request.method === "GET") {
      if (!player) return error("Your player session is not valid. Rejoin the room.", 401);
      return json({ me: this.privateState(room, player) });
    }

    if (!player) return error("Your player session is not valid. Rejoin the room.", 401);

    if (path === "/start" && request.method === "POST") {
      if (!player.isHost) return error("Only the host can start the game.", 403);
      if (room.phase !== "lobby") return error("The game has already started.", 409);
      if (room.players.length < 3) return error("At least 3 players are required.");
      const body = await readJson(request) || {};
      const selectedTopics = Array.isArray(body.topics) ? [...new Set(body.topics.filter((id) => WORD_BANK.topics.some((topic) => topic.id === id)))] : room.settings.topics;
      if (!selectedTopics.length) return error("Choose at least one topic.");
      const rounds = validRoundCount(body.rounds ?? room.settings.rounds ?? MIN_ROUNDS);
      if (!rounds) return error(`Choose between ${MIN_ROUNDS} and ${MAX_ROUNDS} clue rounds.`);
      const availableTopics = WORD_BANK.topics.filter((topic) => selectedTopics.includes(topic.id));
      const topic = availableTopics[crypto.getRandomValues(new Uint32Array(1))[0] % availableTopics.length];
      const word = topic.words[crypto.getRandomValues(new Uint32Array(1))[0] % topic.words.length];
      const requestedImposters = Number(body.imposterCount ?? room.settings.imposterCount ?? 1);
      const imposterCount = Math.max(1, Math.min(3, Number.isFinite(requestedImposters) ? Math.floor(requestedImposters) : 1, room.players.length - 1));
      const shuffled = [...room.players];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      room.settings = {
        topics: selectedTopics,
        imposterCount,
        imposterHint: body.imposterHint !== false,
        rounds
      };
      room.secretWord = word;
      room.categoryId = topic.id;
      room.categoryName = topic.name;
      room.imposterIds = shuffled.slice(0, imposterCount).map((item) => item.id);
      room.phase = "reveal";
      room.currentRound = 1;
      room.roundClues = Array.from({ length: rounds }, () => ({}));
      room.players.forEach((item) => { item.ready = false; });
      room.clues = {};
      room.votes = {};
      room.accusedPlayerId = null;
      room.tiedPlayerIds = [];
      room.winner = null;
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    if (path === "/ready" && request.method === "POST") {
      if (room.phase !== "reveal") return error("The reveal phase is over.", 409);
      player.ready = true;
      if (room.players.every((item) => item.ready)) room.phase = "clues";
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    if (path === "/clue" && request.method === "POST") {
      if (room.phase !== "clues") return error("Clues are not being collected right now.", 409);
      const roundClues = room.roundClues[Math.max(0, room.currentRound - 1)] || {};
      if (roundClues[player.id]) return error("You have already submitted a clue for this round.", 409);
      const body = await readJson(request);
      const clue = typeof body?.clue === "string" ? body.clue.trim() : "";
      if (!clue || clue.length > 24 || /\s/.test(clue)) return error("Enter one word (up to 24 characters).");
      roundClues[player.id] = clue;
      room.roundClues[room.currentRound - 1] = roundClues;
      if (room.players.every((item) => Boolean(roundClues[item.id]))) {
        if (room.currentRound < room.settings.rounds) room.currentRound += 1;
        else room.phase = "voting";
      }
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    if (path === "/vote" && request.method === "POST") {
      if (room.phase !== "voting") return error("Voting is not open right now.", 409);
      if (Object.prototype.hasOwnProperty.call(room.votes, player.id)) return error("You have already voted.", 409);
      const body = await readJson(request);
      const targetId = typeof body?.targetId === "string" ? body.targetId : "";
      if (targetId === player.id) return error("You cannot vote for yourself.");
      if (!room.players.some((item) => item.id === targetId)) return error("Choose a player in this room.");
      room.votes[player.id] = targetId;
      if (Object.keys(room.votes).length === room.players.length) this.resolveVotes(room);
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    if (path === "/tie-break" && request.method === "POST") {
      if (!player.isHost) return error("Only the host can resolve a tied vote.", 403);
      if (room.phase !== "voting_tie") return error("There is no tied vote to resolve.", 409);
      const body = await readJson(request);
      const targetId = typeof body?.targetId === "string" ? body.targetId : "";
      if (!room.tiedPlayerIds.includes(targetId)) return error("Choose one of the tied players.");
      this.resolveAccusation(room, targetId);
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    if (path === "/guess" && request.method === "POST") {
      if (room.phase !== "final_guess") return error("There is no final guess right now.", 409);
      if (room.accusedPlayerId !== player.id || !room.imposterIds.includes(player.id)) return error("Only the accused Imposter can make the final guess.", 403);
      const body = await readJson(request);
      const guess = typeof body?.guess === "string" ? body.guess.trim().toLocaleLowerCase() : "";
      if (!guess) return error("Enter your guess.");
      const correct = guess.localeCompare(room.secretWord.toLocaleLowerCase(), undefined, { sensitivity: "base" }) === 0;
      room.winner = correct ? "imposters" : "players";
      room.phase = "finished";
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room), correct });
    }

    if (path === "/reset" && request.method === "POST") {
      if (!player.isHost) return error("Only the host can start a rematch.", 403);
      room.phase = "lobby";
      room.secretWord = null;
      room.categoryId = null;
      room.categoryName = null;
      room.imposterIds = [];
      room.currentRound = 1;
      room.roundClues = [];
      room.clues = {};
      room.votes = {};
      room.accusedPlayerId = null;
      room.tiedPlayerIds = [];
      room.winner = null;
      room.players.forEach((item) => { item.ready = false; });
      await this.saveRoom(room);
      await this.broadcast(room);
      return json({ state: this.publicState(room) });
    }

    return error("Not found.", 404);
  }

  resolveVotes(room) {
    const counts = new Map();
    for (const targetId of Object.values(room.votes)) counts.set(targetId, (counts.get(targetId) || 0) + 1);
    const highest = Math.max(...counts.values());
    const tied = [...counts.entries()].filter(([, count]) => count === highest).map(([id]) => id);
    if (tied.length > 1) {
      room.phase = "voting_tie";
      room.tiedPlayerIds = tied;
    } else {
      this.resolveAccusation(room, tied[0]);
    }
  }

  resolveAccusation(room, targetId) {
    room.accusedPlayerId = targetId;
    room.tiedPlayerIds = [];
    if (room.imposterIds.includes(targetId)) {
      room.phase = "final_guess";
    } else {
      room.phase = "finished";
      room.winner = "imposters";
    }
  }

  async handleWebSocket(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return error("WebSocket upgrade required.", 426);
    const room = await this.loadRoom();
    const player = room ? this.playerForToken(room, url.searchParams.get("token")) : null;
    if (!room || !player) return error("Invalid room or player session.", 401);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`player:${player.id}`]);
    try { server.send(JSON.stringify({ type: "room:update", state: this.publicState(room) })); } catch { /* ignore initial send failure */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (message === "ping") {
      try { socket.send("pong"); } catch { /* ignore */ }
    }
  }
}


/**
 * One ActivitySession Durable Object coordinates the shared room for a Discord
 * Activity instance. Every participant is verified by the Worker with Discord
 * first, then idempotently mapped to a normal GameRoom player session.
 */
export class ActivitySession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/enter" || request.method !== "POST") return error("Not found.", 404);
    const operation = this.queue.then(() => this.enter(request), () => this.enter(request));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async roomRequest(code, path, { method = "GET", token, body, init = false } = {}) {
    const stub = this.env.GAME_ROOMS.get(this.env.GAME_ROOMS.idFromName(code));
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (init) headers["x-room-code"] = code;
    const target = new URL(`https://room/${path}`);
    if (token) target.searchParams.set("token", token);
    return stub.fetch(new Request(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
  }

  async createRoom(hostName) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode();
      const response = await this.roomRequest(code, "init", {
        method: "POST", body: { hostName }, init: true
      });
      if (response.status === 409) continue;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { error: data.error || "Could not create a Discord game room.", status: response.status };
      return { data };
    }
    return { error: "Could not allocate a room code. Please relaunch the Activity.", status: 503 };
  }

  async joinRoom(code, baseName) {
    for (let suffix = 1; suffix <= 20; suffix += 1) {
      const suffixText = suffix === 1 ? "" : ` ${suffix}`;
      const name = normalizeName(`${baseName.slice(0, 18 - suffixText.length)}${suffixText}`);
      const response = await this.roomRequest(code, "join", { method: "POST", body: { name } });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { data };
      if (!/already taken/i.test(data.error || "")) return { error: data.error || "Could not join the Discord game room.", status: response.status };
    }
    return { error: "Could not find a unique player name for this Discord account.", status: 409 };
  }

  async existingPlayer(code, savedPlayer) {
    const [stateResponse, meResponse] = await Promise.all([
      this.roomRequest(code, "state", { token: savedPlayer.token }),
      this.roomRequest(code, "me", { token: savedPlayer.token })
    ]);
    if (!stateResponse.ok || !meResponse.ok) return null;
    const [stateData, meData] = await Promise.all([stateResponse.json(), meResponse.json()]);
    return { code, token: savedPlayer.token, player: savedPlayer.player, state: stateData.state, me: meData.me };
  }

  async enter(request) {
    const body = await readJson(request) || {};
    const discordUserId = typeof body.discordUserId === "string" ? body.discordUserId : "";
    const name = normalizeName(body.name) || "Discord Player";
    if (!/^\d{5,25}$/.test(discordUserId)) return error("Discord returned an invalid user ID.", 401);

    let session = await this.ctx.storage.get("session") || { code: null, users: {} };
    session.users ||= {};

    if (session.code && session.users[discordUserId]) {
      const existing = await this.existingPlayer(session.code, session.users[discordUserId]);
      if (existing) return json(existing);
      // The linked room may have expired. Start a clean Activity session below.
      session = { code: null, users: {} };
    }

    if (!session.code) {
      const created = await this.createRoom(name);
      if (created.error) return error(created.error, created.status);
      const data = created.data;
      session.code = data.code;
      session.users[discordUserId] = { token: data.token, player: data.player };
      await this.ctx.storage.put("session", session);
      return json(data, 201);
    }

    const joined = await this.joinRoom(session.code, name);
    if (joined.error && joined.status === 404) {
      // If the underlying game room expired while this Activity directory remained,
      // allocate a fresh room and start a fresh participant map.
      session = { code: null, users: {} };
      const recreated = await this.createRoom(name);
      if (recreated.error) return error(recreated.error, recreated.status);
      const data = recreated.data;
      session.code = data.code;
      session.users[discordUserId] = { token: data.token, player: data.player };
      await this.ctx.storage.put("session", session);
      return json(data, 201);
    }
    if (joined.error) return error(joined.error, joined.status);
    const data = joined.data;
    session.users[discordUserId] = { token: data.token, player: data.player };
    await this.ctx.storage.put("session", session);
    return json(data, 201);
  }
}
