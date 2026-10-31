import test from "node:test";
import assert from "node:assert/strict";
import { GameRoom } from "../src/index.js";
import { WORD_BANK } from "../src/wordbank.js";

function makeRoom({ word = "cat", category = "Animals", hintEnabled = true } = {}) {
  return {
    players: [{ id: "player-1", name: "Player One", isHost: true, token: "token" }],
    imposterIds: ["player-1"],
    phase: "reveal",
    secretWord: word,
    categoryName: category,
    settings: { imposterHint: hintEnabled },
    clues: {},
    votes: {},
    accusedPlayerId: null
  };
}

const gameRoom = new GameRoom({ id: { name: "TEST01" } }, {});

test("Imposter hint is suppressed when it exactly matches the secret word", () => {
  const room = makeRoom({ word: "Cat", category: " cat " });
  const privateState = gameRoom.privateState(room, room.players[0]);
  assert.equal(privateState.hint, null);
});

test("Imposter hint is suppressed for Unicode-normalized exact matches", () => {
  const room = makeRoom({ word: "Café", category: "Cafe\u0301" });
  const privateState = gameRoom.privateState(room, room.players[0]);
  assert.equal(privateState.hint, null);
});

test("A non-matching category hint is preserved", () => {
  const room = makeRoom({ word: "cat", category: "Animals" });
  const privateState = gameRoom.privateState(room, room.players[0]);
  assert.equal(privateState.hint, "Animals");
});

test("The category hint can be disabled", () => {
  const room = makeRoom({ word: "cat", category: "Animals", hintEnabled: false });
  const privateState = gameRoom.privateState(room, room.players[0]);
  assert.equal(privateState.hint, null);
});

test("The bundled word bank has 2,000 unique words across 21 topics", () => {
  const words = WORD_BANK.topics.flatMap((topic) => topic.words);
  assert.equal(WORD_BANK.wordCount, 2000);
  assert.equal(WORD_BANK.topics.length, 21);
  assert.equal(words.length, 2000);
  assert.equal(new Set(words.map((word) => word.toLocaleLowerCase())).size, 2000);
});

function makeContext() {
  const records = new Map();
  return {
    id: { name: "ROUND1" },
    storage: {
      get: async (key) => records.get(key) || null,
      put: async (key, value) => records.set(key, structuredClone(value)),
      deleteAll: async () => records.clear()
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {}
  };
}

async function post(room, path, token, body = {}) {
  return room.fetch(new Request(`https://room/${path}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

async function makeStartedThreePlayerRoom(rounds = 3) {
  const context = makeContext();
  const room = new GameRoom(context, {});
  const initResponse = await room.fetch(new Request("https://room/init", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-room-code": "ROUND1" },
    body: JSON.stringify({ hostName: "Host" })
  }));
  const host = await initResponse.json();
  const players = [{ id: host.player.id, name: "Host", token: host.token }];
  for (const name of ["Player Two", "Player Three"]) {
    const joinResponse = await room.fetch(new Request("https://room/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    }));
    const joined = await joinResponse.json();
    players.push({ id: joined.player.id, name, token: joined.token });
  }
  const startResponse = await post(room, "start", host.token, {
    topics: [WORD_BANK.topics[0].id],
    imposterCount: 1,
    rounds
  });
  return { room, players, startResponse };
}

test("A room rejects fewer than three clue rounds", async () => {
  const { startResponse } = await makeStartedThreePlayerRoom(2);
  assert.equal(startResponse.status, 400);
  const data = await startResponse.json();
  assert.match(data.error, /between 3 and 10/);
});

test("All players submit a clue in each configured round before voting opens", async () => {
  const { room, players, startResponse } = await makeStartedThreePlayerRoom(3);
  assert.equal(startResponse.status, 200);
  let data = await startResponse.json();
  assert.equal(data.state.currentRound, 1);
  assert.equal(data.state.totalRounds, 3);

  for (const player of players) {
    await post(room, "ready", player.token);
  }
  for (let round = 1; round <= 3; round += 1) {
    for (const player of players) {
      const response = await post(room, "clue", player.token, { clue: `clue${round}${player.name.replace(/\s/g, "")}` });
      assert.equal(response.status, 200);
      data = await response.json();
    }
    const stateResponse = await room.fetch(new Request(`https://room/state?token=${players[0].token}`));
    data = await stateResponse.json();
    if (round < 3) {
      assert.equal(data.state.phase, "clues");
      assert.equal(data.state.currentRound, round + 1);
      assert.equal(data.state.clueCount, 0);
    } else {
      assert.equal(data.state.phase, "voting");
      assert.equal(data.state.currentRound, 3);
      assert.equal(data.state.allClues.length, 9);
    }
  }
});

test("A room accepts the maximum of ten clue rounds", async () => {
  const { startResponse } = await makeStartedThreePlayerRoom(10);
  assert.equal(startResponse.status, 200);
  const data = await startResponse.json();
  assert.equal(data.state.totalRounds, 10);
  assert.equal(data.state.currentRound, 1);
});

test("A room rejects more than ten clue rounds", async () => {
  const { startResponse } = await makeStartedThreePlayerRoom(11);
  assert.equal(startResponse.status, 400);
});
