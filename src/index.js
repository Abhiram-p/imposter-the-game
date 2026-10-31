import { WORD_BANK } from "./wordbank.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 12;
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

function corsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, app: "imposter-the-game", version: "1.0.0" });
    }

    if (url.pathname === "/api/topics" && request.method === "GET") {
      return json({ topics: topicList(), wordCount: WORD_BANK.wordCount });
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
    const output = {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map(({ id, name, isHost, ready, online }) => ({ id, name, isHost, ready, online })),
      settings: room.settings,
      clues: Object.entries(room.clues).map(([playerId, text]) => ({ playerId, playerName: playerNames.get(playerId) || "Player", text })),
      clueCount: Object.keys(room.clues).length,
      voteCount: Object.keys(room.votes).length,
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
        }))
      };
    }
    return output;
  }

  privateState(room, player) {
    const isImposter = room.imposterIds.includes(player.id);
    return {
      player: { id: player.id, name: player.name, isHost: player.isHost },
      phase: room.phase,
      role: room.phase === "lobby" ? null : (isImposter ? "imposter" : "civilian"),
      word: room.phase === "lobby" || isImposter ? null : room.secretWord,
      category: room.phase === "lobby" ? null : room.categoryName,
      hint: room.phase !== "lobby" && isImposter && room.settings.imposterHint ? room.categoryName : null,
      ready: Boolean(player.ready),
      hasClue: Boolean(room.clues[player.id]),
      clue: room.clues[player.id] || null,
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
        settings: { topics: WORD_BANK.topics.map((topic) => topic.id), imposterCount: 1, imposterHint: true },
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
        imposterHint: body.imposterHint !== false
      };
      room.secretWord = word;
      room.categoryId = topic.id;
      room.categoryName = topic.name;
      room.imposterIds = shuffled.slice(0, imposterCount).map((item) => item.id);
      room.phase = "reveal";
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
      if (room.clues[player.id]) return error("You have already submitted a clue.", 409);
      const body = await readJson(request);
      const clue = typeof body?.clue === "string" ? body.clue.trim() : "";
      if (!clue || clue.length > 24 || /\s/.test(clue)) return error("Enter one word (up to 24 characters).");
      room.clues[player.id] = clue;
      if (room.players.every((item) => Boolean(room.clues[item.id]))) room.phase = "voting";
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
