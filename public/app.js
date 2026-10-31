const $ = (selector, root = document) => root.querySelector(selector);
const bootParams = new URLSearchParams(location.search);
const discordInstanceId = bootParams.get("instance_id") || "";
const inDiscordFrame = bootParams.has("frame_id") && bootParams.has("instance_id") && bootParams.has("platform");
const sessionStorageKey = inDiscordFrame ? `imposter-session:discord:${discordInstanceId}` : "imposter-session";
const state = {
  code: null,
  token: null,
  player: null,
  room: null,
  me: null,
  topics: [],
  lastSignature: "",
  revealVisible: false,
  socket: null,
  pollTimer: null,
  offline: null,
  offlineSetup: null,
  wordBank: null,
  discord: null,
  discordError: null
};

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(sessionStorageKey) || "null"); }
  catch { return null; }
})();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function saveSession() {
  localStorage.setItem(sessionStorageKey, JSON.stringify({ code: state.code, token: state.token, player: state.player }));
}

function clearSession() {
  localStorage.removeItem(sessionStorageKey);
  state.code = state.token = state.player = state.room = state.me = null;
  state.lastSignature = "";
  state.revealVisible = false;
  state.offline = null;
  if (state.socket) state.socket.close();
  state.socket = null;
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  let url = path;
  if (auth && state.token) url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(state.token)}`;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); }
  catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setSession(data) {
  state.code = data.code;
  state.token = data.token;
  state.player = data.player;
  state.room = data.state;
  state.me = { player: data.player, role: null, ready: false, hasClue: false, hasVoted: false };
  state.lastSignature = "";
  state.revealVisible = false;
  saveSession();
  connectSocket();
  startPolling();
  render();
}

async function loadTopics() {
  // The public word bank is cached by the service worker, so local pass-the-phone
  // games can start without making any API requests.
  try {
    const response = await fetch("/wordbank.json", { cache: "no-cache" });
    if (response.ok) state.wordBank = await response.json();
  } catch { /* The online game can still work without the offline word bank. */ }

  try {
    const data = await api("/api/topics", { auth: false });
    state.topics = data.topics || [];
  } catch {
    state.topics = (state.wordBank?.topics || []).map(({ id, name, description, wordCount }) => ({ id, name, description, wordCount }));
  }
}

async function refreshRoom(forceRender = false) {
  if (!state.code || !state.token) return;
  try {
    const [roomData, meData] = await Promise.all([
      api(`/api/rooms/${state.code}/state`),
      api(`/api/rooms/${state.code}/me`)
    ]);
    const previousPhase = state.room?.phase;
    state.room = roomData.state;
    state.me = meData.me;
    if (previousPhase !== state.room.phase) state.revealVisible = false;
    const signature = JSON.stringify([state.room, state.me]);
    if (forceRender || signature !== state.lastSignature) {
      state.lastSignature = signature;
      render();
    }
  } catch (error) {
    if (/session is not valid|not found|expired/i.test(error.message)) {
      clearSession();
      renderHome();
    } else if (forceRender) showToast(error.message);
  }
}

function connectSocket() {
  if (!state.code || !state.token) return;
  if (state.socket) state.socket.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${state.code}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.addEventListener("message", () => refreshRoom(true));
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => refreshRoom(false), 2600);
}

function renderHome() {
  const queryCode = new URLSearchParams(location.search).get("room") || "";
  $("#view").innerHTML = `
    <section class="panel center">
      <div class="hero-mark">?</div>
      <div class="eyebrow">The social deduction word game</div>
      <h1>Who doesn't<br>know the word?</h1>
      <p class="lead">Everyone gets the same secret word. Except one player. Give clues, stay convincing, and find the Imposter.</p>
      ${state.discord?.user ? `<div class="muted-block" style="margin:16px 0">Connected to Discord as <strong>${escapeHTML(state.discord.user.global_name || state.discord.user.username || "Player")}</strong>. This Activity has its own shared game room.</div>` : state.discordError ? `<div class="muted-block" style="margin:16px 0">Discord connection unavailable: ${escapeHTML(state.discordError)}</div>` : ""}
      <div class="form-stack">
        <form id="create-form" class="form-stack">
          <div><label class="field-label" for="host-name">Your name</label><input class="input" id="host-name" maxlength="18" placeholder="Enter your player name" required autocomplete="nickname"></div>
          <button class="btn btn-primary" type="submit">Create a room <span aria-hidden="true">→</span></button>
        </form>
        <div class="separator">OR JOIN FRIENDS</div>
        <form id="join-form" class="form-stack">
          <div><label class="field-label" for="join-name">Your name</label><input class="input" id="join-name" maxlength="18" placeholder="Enter your player name" required autocomplete="nickname"></div>
          <div><label class="field-label" for="join-code">Room code</label><input class="input" id="join-code" maxlength="6" placeholder="6-character code" value="${escapeHTML(queryCode.toUpperCase())}" required autocapitalize="characters" autocomplete="off"></div>
          <button class="btn btn-secondary" type="submit">Join a room</button>
        </form>
        <button class="btn btn-secondary offline-entry" id="offline-mode" type="button"><span aria-hidden="true">▣</span> Play offline · Pass the phone</button>
      </div>
      <p class="inline-note" style="margin:22px auto 0">3–12 players · No account required · Works on phones and desktops</p>
    </section>`;

  if (state.discord?.user) {
    const displayName = state.discord.user.global_name || state.discord.user.username || "";
    $("#host-name").value = displayName.slice(0, 18);
    $("#join-name").value = displayName.slice(0, 18);
  }

  $("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("button[type=submit]", event.currentTarget);
    button.disabled = true;
    try {
      const data = await api("/api/rooms", { method: "POST", body: { hostName: $("#host-name").value.trim() }, auth: false });
      setSession(data);
      history.replaceState({}, "", `/?room=${data.code}`);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });

  $("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("button[type=submit]", event.currentTarget);
    button.disabled = true;
    try {
      const code = $("#join-code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const name = $("#join-name").value.trim();
      const data = await api(`/api/rooms/${code}/join`, { method: "POST", body: { name }, auth: false });
      setSession(data);
      history.replaceState({}, "", `/?room=${data.code}`);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });

  $("#offline-mode").addEventListener("click", () => {
    if (!state.wordBank?.topics?.length) {
      showToast("Offline word list isn't available yet. Connect once and reload the game.");
      return;
    }
    state.offlineSetup = state.offlineSetup || {
      players: [],
      topics: state.wordBank.topics.map((topic) => topic.id),
      imposterCount: 1,
      imposterHint: true,
      rounds: 3
    };
    renderOfflineSetup();
  });
}

function playerCards(players) {
  return `<div class="player-grid">${players.map((player) => `
    <div class="player-chip"><span class="avatar">${escapeHTML(player.name.slice(0, 1).toUpperCase())}</span><span class="player-name">${escapeHTML(player.name)}</span>${player.isHost ? '<span class="host-tag">HOST</span>' : ""}</div>`).join("")}</div>`;
}

function lobbyView() {
  const room = state.room;
  const isHost = state.me?.player?.isHost;
  const categories = state.topics.length ? state.topics : [];
  const settings = room.settings || {};
  const selected = new Set(settings.topics || categories.map((topic) => topic.id));
  return `
    <section class="panel wide">
      <div class="room-head">
        <div><div class="eyebrow">Waiting room</div><h2>Bring your people in.</h2><p class="inline-note">${state.discord ? "Players who open this Discord Activity join this same lobby automatically." : "Share the code. The game starts when everyone is ready."}</p></div>
        <div><div class="field-label">ROOM CODE</div><button class="room-code" id="copy-code" type="button">${escapeHTML(room.code)} <span>↗</span></button>${state.discord ? '<button class="btn btn-quiet" id="discord-invite" type="button" style="margin-top:8px">Invite to Discord channel</button>' : ""}</div>
      </div>
      <div class="section" style="border-top:0;padding-top:0;margin-top:0">
        <div class="section-head"><h3>Players</h3><span class="pill">${room.players.length} / 12 joined</span></div>
        ${playerCards(room.players)}
      </div>
      ${isHost ? `
      <div class="section">
        <div class="section-head"><h3>Choose topics</h3><span class="pill" id="topic-count">${selected.size} selected</span></div>
        <div class="topic-grid" id="topic-grid">${categories.map((topic) => `
          <label class="topic-option"><input type="checkbox" name="topic" value="${escapeHTML(topic.id)}" ${selected.has(topic.id) ? "checked" : ""}><span>${escapeHTML(topic.name)}</span></label>`).join("")}</div>
        <div class="setting-row"><span>Number of Imposters</span><select id="imposter-count"><option value="1" ${settings.imposterCount === 1 ? "selected" : ""}>1</option><option value="2" ${settings.imposterCount === 2 ? "selected" : ""}>2</option><option value="3" ${settings.imposterCount === 3 ? "selected" : ""}>3</option></select></div>
        <div class="setting-row"><span>Clue rounds (minimum 3)</span><select id="round-count">${Array.from({ length: 8 }, (_, index) => index + 3).map((count) => `<option value="${count}" ${(settings.rounds || 3) === count ? "selected" : ""}>${count} rounds</option>`).join("")}</select></div>
        <div class="setting-row"><span>Give the Imposter a category hint</span><label class="switch"><input id="imposter-hint" type="checkbox" ${settings.imposterHint !== false ? "checked" : ""}><span>On</span></label></div>
        <p class="inline-note" style="margin:13px 0 0">Everyone submits one clue in each round. Voting opens only after all selected clue rounds are complete. Minimum 3, maximum 10.</p>
      </div>
      <div class="section button-row"><button class="btn btn-primary" id="start-game" ${room.players.length < 3 ? "disabled" : ""}>Start game <span>→</span></button><button class="btn btn-quiet" id="leave-room">Leave room</button></div>
      ${room.players.length < 3 ? '<p class="inline-note center">At least 3 players are needed to start.</p>' : ''}` : `
      <div class="section muted-block"><div class="loader" style="margin:0 auto 13px"></div><strong>Waiting for the host</strong><p style="margin:7px 0 0">The host is choosing the topics and game settings.</p></div>
      <div class="button-row"><button class="btn btn-quiet" id="leave-room">Leave room</button></div>`}
    </section>`;
}

function revealView() {
  const me = state.me;
  const room = state.room;
  const ready = me.ready;
  let card = "";
  if (state.revealVisible) {
    const imposter = me.role === "imposter";
    card = `<div class="word-card"><div class="role-label">Your secret role</div><div class="secret-word ${imposter ? "imposter" : ""}">${imposter ? "IMPOSTER" : escapeHTML(me.word || "")}</div><div class="word-hint">${imposter ? (me.hint ? `Your category hint: ${escapeHTML(me.hint)}` : "You have no word. Blend in.") : `Category: ${escapeHTML(me.category)}`}</div></div>`;
  }
  return `<section class="panel center">
    <div class="eyebrow">Private role reveal · ${escapeHTML(room.code)}</div>
    <h2>${ready ? "You're all set." : "Your role is waiting."}</h2>
    <p class="lead">Only look at your own screen. Don't show your card to anyone else.</p>
    ${ready ? '<div class="word-card"><div class="loader" style="margin:0 auto 14px"></div><strong>Waiting for the other players</strong><div class="word-hint">The clue round begins once everyone has confirmed their role.</div></div>' : state.revealVisible ? card : '<div class="word-card"><div class="role-label">Your card is private</div><div class="secret-word">••••••••</div><div class="word-hint">Tap below when you are ready to look.</div></div>'}
    ${!ready ? `<div class="button-row"><button class="btn btn-secondary" id="reveal-card">${state.revealVisible ? "Hide my role" : "Reveal my role"}</button>${state.revealVisible ? '<button class="btn btn-primary" id="ready-up">I understand — continue</button>' : ""}</div>` : ""}
    <div class="section"><div class="section-head"><h3>Players ready</h3><span class="pill">${room.players.filter((player) => player.ready).length} / ${room.players.length}</span></div><div class="progress-list">${room.players.map((player) => `<div class="progress-item"><span>${escapeHTML(player.name)}</span><span class="${player.ready ? "status-done" : "status-wait"}">${player.ready ? "READY" : "WAITING"}</span></div>`).join("")}</div></div>
  </section>`;
}

function clueBoard(allRounds = false) {
  const room = state.room;
  const clues = allRounds ? (room.allClues || []) : (room.clues || []);
  if (!clues.length) return '<div class="muted-block">No clues submitted yet.</div>';
  if (!allRounds) return `<div class="clue-list">${clues.map((clue) => `<div class="clue-card"><span>${escapeHTML(clue.playerName)}</span><strong>${escapeHTML(clue.text)}</strong></div>`).join("")}</div>`;
  const rounds = [...new Set(clues.map((clue) => clue.round))].sort((a, b) => a - b);
  return rounds.map((round) => `<div class="section"><div class="section-head"><h3>Clue round ${round}</h3><span class="pill">${clues.filter((clue) => clue.round === round).length} clues</span></div><div class="clue-list">${clues.filter((clue) => clue.round === round).map((clue) => `<div class="clue-card"><span>${escapeHTML(clue.playerName)}</span><strong>${escapeHTML(clue.text)}</strong></div>`).join("")}</div></div>`).join("");
}

function clueView() {
  const me = state.me;
  const room = state.room;
  const submitted = me.hasClue;
  return `<section class="panel wide">
    <div class="eyebrow">Clue round ${room.currentRound} of ${room.totalRounds}</div><h2>Say one word.</h2><p class="inline-note">Each player gives one clue in every round. The vote opens after round ${room.totalRounds}. Give a clue connected to your secret word without making it too obvious.</p>
    <div class="progress-track"><span style="width:${((room.currentRound - 1) / room.totalRounds) * 100}%"></span></div>
    ${submitted ? `<div class="word-card"><div class="role-label">Your clue for round ${room.currentRound} is locked in</div><div class="secret-word">${escapeHTML(me.clue)}</div><div class="word-hint">Waiting for the other players to submit this round's clue.</div></div>` : `<form id="clue-form" class="form-stack" style="margin:20px 0 0"><div><label class="field-label" for="clue-input">Your one-word clue · Round ${room.currentRound}</label><input class="input" id="clue-input" maxlength="24" placeholder="Type one word…" required autocomplete="off"></div><button class="btn btn-primary" type="submit">Submit clue for round ${room.currentRound}</button></form>`}
    <div class="section"><div class="section-head"><h3>Clues submitted this round</h3><span class="pill">${room.clueCount} / ${room.players.length}</span></div>${clueBoard()}</div>
  </section>`;
}

function votingView() {
  const me = state.me;
  const room = state.room;
  return `<section class="panel wide">
    <div class="eyebrow">All ${room.totalRounds} clue rounds complete</div><h2>Who is the Imposter?</h2><p class="inline-note">Review every clue from every round, discuss with your group, then vote for the player you suspect. You cannot vote for yourself.</p>
    ${clueBoard(true)}
    <div class="section"><div class="section-head"><h3>Your vote</h3><span class="pill">${room.voteCount} / ${room.players.length} votes cast</span></div>
      ${me.hasVoted ? '<div class="muted-block">Your vote is locked. Waiting for the others.</div>' : `<div class="vote-grid">${room.players.filter((player) => player.id !== me.player.id).map((player) => `<button type="button" class="vote-card" data-vote="${escapeHTML(player.id)}"><span>${escapeHTML(player.name)}</span><small>Vote for this player</small></button>`).join("")}</div>`}
    </div>
  </section>`;
}

function tieView() {
  const host = state.me?.player?.isHost;
  return `<section class="panel center"><div class="eyebrow">Vote tie</div><h2>The room is split.</h2><p class="lead">The host must select one of the tied players to break the tie.</p>${host ? `<div class="vote-grid">${state.room.tiedPlayers.map((player) => `<button class="vote-card" data-tiebreak="${escapeHTML(player.id)}"><span>${escapeHTML(player.name)}</span><small>Choose for tie-break</small></button>`).join("")}</div>` : '<div class="muted-block">Waiting for the host to resolve the tie.</div>'}</section>`;
}

function guessView() {
  if (!state.me.canGuess) return `<section class="panel center"><div class="eyebrow">Final guess</div><h2>The Imposter has been caught.</h2><p class="lead">The accused player has one chance to guess the secret word. Everyone else, wait for the reveal.</p><div class="word-card"><div class="loader" style="margin:0 auto 13px"></div><div class="word-hint">Waiting for the final guess…</div></div></section>`;
  return `<section class="panel center"><div class="eyebrow">One final chance</div><h2>Guess the secret word.</h2><p class="lead">You were identified. Guess the word correctly to steal the win for the Imposters.</p><form id="guess-form" class="form-stack"><div><label class="field-label" for="guess-input">Your final guess</label><input class="input" id="guess-input" maxlength="40" placeholder="What is the word?" required autocomplete="off"></div><button class="btn btn-primary" type="submit">Lock in my guess</button></form></section>`;
}

function finishedView() {
  const result = state.room.result || {};
  const impostersWon = result.winner === "imposters";
  const isImposter = state.me.role === "imposter";
  return `<section class="panel wide">
    <div class="eyebrow">Game over · ${escapeHTML(state.room.code)}</div>
    <div class="result-banner ${impostersWon ? "imposters" : "players"}"><h2>${impostersWon ? "The Imposters win." : "The players win."}</h2><p>${impostersWon ? "The group couldn't stop the deception." : "The group found the Imposter and protected the word."}</p></div>
    <div class="center"><div class="role-label">The secret word was</div><div class="result-word">${escapeHTML(result.word || "—")}</div><p class="inline-note">Topic: ${escapeHTML(result.category || "—")}</p></div>
    <div class="section"><div class="section-head"><h3>The Imposter${(result.imposters || []).length > 1 ? "s" : ""}</h3><span class="pill">${(result.imposters || []).length} player${(result.imposters || []).length === 1 ? "" : "s"}</span></div>${playerCards(result.imposters || [])}</div>
    <div class="section"><div class="section-head"><h3>All clue rounds</h3></div>${clueBoard(true)}</div>
    ${result.votes?.length ? `<div class="section"><div class="section-head"><h3>Voting record</h3></div><div class="progress-list">${result.votes.map((vote) => `<div class="progress-item"><span>${escapeHTML(vote.voterName)}</span><span class="status-wait">voted for ${escapeHTML(vote.targetName)}</span></div>`).join("")}</div></div>` : ""}
    <div class="section button-row">${state.me.player.isHost ? '<button class="btn btn-primary" id="rematch">Play again</button>' : '<div class="muted-block" style="flex:1">Waiting for the host to start a rematch.</div>'}<button class="btn btn-quiet" id="exit-room">Exit room</button></div>
  </section>`;
}

function renderOfflineSetup() {
  const setup = state.offlineSetup;
  const topics = state.wordBank?.topics || [];
  const selected = new Set(setup.topics);
  const playersHtml = setup.players.length
    ? `<div class="offline-player-list">${setup.players.map((name, index) => `<div class="progress-item"><span>${index + 1}. ${escapeHTML(name)}</span><button class="remove-player" type="button" data-remove-player="${index}" aria-label="Remove ${escapeHTML(name)}">Remove</button></div>`).join("")}</div>`
    : '<div class="muted-block">Add at least 3 players to get started.</div>';

  $("#view").innerHTML = `
    <section class="panel wide">
      <div class="eyebrow">Offline mode · One phone</div>
      <h2>Set up your room.</h2>
      <p class="inline-note">Add everyone who is playing. Then pass the same phone around so each person can privately reveal their role.</p>
      <div class="section" style="border-top:0;padding-top:0;margin-top:20px">
        <div class="section-head"><h3>Players</h3><span class="pill">${setup.players.length} / 12</span></div>
        <form id="offline-player-form" class="add-player-form">
          <input class="input" id="offline-player-name" maxlength="18" placeholder="Enter a player name" autocomplete="off" required>
          <button class="btn btn-secondary" type="submit" ${setup.players.length >= 12 ? "disabled" : ""}>Add player</button>
        </form>
        ${playersHtml}
      </div>
      <div class="section">
        <div class="section-head"><h3>Choose topics</h3><span class="pill" id="offline-topic-count">${selected.size} selected</span></div>
        <div class="topic-grid" id="offline-topic-grid">${topics.map((topic) => `<label class="topic-option"><input type="checkbox" name="offline-topic" value="${escapeHTML(topic.id)}" ${selected.has(topic.id) ? "checked" : ""}><span>${escapeHTML(topic.name)}</span></label>`).join("")}</div>
        <div class="setting-row"><span>Number of Imposters</span><select id="offline-imposter-count"><option value="1" ${setup.imposterCount === 1 ? "selected" : ""}>1</option><option value="2" ${setup.imposterCount === 2 ? "selected" : ""}>2</option><option value="3" ${setup.imposterCount === 3 ? "selected" : ""}>3</option></select></div>
        <div class="setting-row"><span>Clue rounds (minimum 3)</span><select id="offline-round-count">${Array.from({ length: 8 }, (_, index) => index + 3).map((count) => `<option value="${count}" ${(setup.rounds || 3) === count ? "selected" : ""}>${count} rounds</option>`).join("")}</select></div>
        <div class="setting-row"><span>Give the Imposter a category hint</span><label class="switch"><input id="offline-imposter-hint" type="checkbox" ${setup.imposterHint ? "checked" : ""}><span>On</span></label></div>
        <p class="inline-note" style="margin:12px 0 0">The Imposter's hint will never reveal the exact secret word.</p>
      </div>
      <div class="section button-row">
        <button class="btn btn-primary" id="offline-start" type="button" ${setup.players.length < 3 ? "disabled" : ""}>Deal roles <span>→</span></button>
        <button class="btn btn-quiet" id="offline-back-home" type="button">Back</button>
      </div>
    </section>`;

  $("#offline-player-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#offline-player-name");
    const name = input.value.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!name) return;
    if (setup.players.length >= 12) return showToast("A maximum of 12 players is supported.");
    if (setup.players.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())) return showToast("That player name is already on the list.");
    setup.players.push(name);
    renderOfflineSetup();
    $("#offline-player-name")?.focus();
  });

  $("#offline-topic-grid").addEventListener("change", () => {
    setup.topics = [...$("#offline-topic-grid").querySelectorAll("input:checked")].map((input) => input.value);
    $("#offline-topic-count").textContent = `${setup.topics.length} selected`;
  });

  $("#view").querySelectorAll("[data-remove-player]").forEach((button) => {
    button.addEventListener("click", () => {
      setup.players.splice(Number(button.dataset.removePlayer), 1);
      renderOfflineSetup();
    });
  });

  $("#offline-start").addEventListener("click", () => {
    setup.topics = [...$("#offline-topic-grid").querySelectorAll("input:checked")].map((input) => input.value);
    setup.imposterCount = Number($("#offline-imposter-count").value);
    setup.rounds = Number($("#offline-round-count").value);
    setup.imposterHint = $("#offline-imposter-hint").checked;
    if (setup.players.length < 3) return showToast("Add at least 3 players.");
    if (!setup.topics.length) return showToast("Choose at least one topic.");
    startOfflineRound();
  });

  $("#offline-back-home").addEventListener("click", () => renderHome());
}

function startOfflineRound() {
  const setup = state.offlineSetup;
  const topics = (state.wordBank?.topics || []).filter((topic) => setup.topics.includes(topic.id));
  if (!topics.length) return showToast("No words are available for those topics.");
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const word = topic.words[Math.floor(Math.random() * topic.words.length)];
  const players = setup.players.map((name, index) => ({ id: `local_${index}_${Math.random().toString(36).slice(2, 8)}`, name }));
  const shuffled = [...players];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  const count = Math.max(1, Math.min(3, setup.imposterCount, players.length - 1));
  const imposterIds = shuffled.slice(0, count).map((player) => player.id);
  const normalizeHint = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
  const hint = setup.imposterHint && normalizeHint(topic.name) !== normalizeHint(word) ? topic.name : null;

  state.offline = {
    phase: "passing",
    players,
    topic: topic.name,
    word,
    imposterIds,
    hint,
    rounds: Math.max(3, Math.min(10, Number(setup.rounds) || 3)),
    currentRound: 1,
    currentPlayerIndex: 0,
    currentVoterIndex: 0,
    votes: {},
    seenPlayerIds: [],
    revealVisible: false
  };
  renderOffline();
}

function offlineRoleCard(player) {
  const game = state.offline;
  const isImposter = game.imposterIds.includes(player.id);
  if (isImposter) {
    return `<div class="role-label">Your secret role</div><div class="secret-word imposter">IMPOSTER</div><div class="word-hint">${game.hint ? `Your category hint: ${escapeHTML(game.hint)}` : "You have no word. Blend in."}</div>`;
  }
  return `<div class="role-label">Your secret word</div><div class="secret-word">${escapeHTML(game.word)}</div><div class="word-hint">Category: ${escapeHTML(game.topic)}</div>`;
}

function renderOffline() {
  const game = state.offline;
  if (!game) return renderHome();

  if (game.phase === "passing") {
    const player = game.players[game.currentPlayerIndex];
    const hasSeen = game.seenPlayerIds.includes(player.id);
    const progress = game.seenPlayerIds.length;
    $("#view").innerHTML = `
      <section class="panel center offline-panel">
        <div class="eyebrow">Offline mode · Private role ${game.currentPlayerIndex + 1} of ${game.players.length}</div>
        <h2>Pass the phone to</h2>
        <div class="offline-current-player">${escapeHTML(player.name)}</div>
        <p class="lead">Make sure nobody else can see the screen. Press and hold the button below to reveal your role. Release to hide it.</p>
        <div id="offline-role-card" class="word-card offline-reveal-card" hidden aria-live="polite"></div>
        <button class="btn btn-secondary hold-reveal" id="offline-hold" type="button">Press &amp; hold to reveal role</button>
        <div class="section">
          <div class="section-head"><h3>Roles viewed</h3><span class="pill">${progress} / ${game.players.length}</span></div>
          <div class="progress-track"><span style="width:${(progress / game.players.length) * 100}%"></span></div>
        </div>
        <button class="btn btn-primary offline-next" id="offline-next" type="button" ${hasSeen ? "" : "disabled"}>${game.currentPlayerIndex === game.players.length - 1 ? "Everyone has seen their role — start the round" : "Hide role & pass to next player"} <span>→</span></button>
        <button class="btn btn-quiet offline-back" id="offline-cancel" type="button">Cancel round</button>
      </section>`;
    attachOfflinePassingHandlers(player);
    return;
  }

  if (game.phase === "playing") {
    $("#view").innerHTML = `
      <section class="panel center">
        <div class="eyebrow">Offline mode · Clue round ${game.currentRound} of ${game.rounds}</div>
        <h2>Keep the secret.</h2>
        <p class="lead">All players have received their roles. Give one clue each, discuss, then the host advances the round. Voting starts after all ${game.rounds} rounds.</p>
        <div class="word-card"><div class="role-label">Secret word</div><div class="secret-word">••••••••</div><div class="word-hint">The word and Imposter identities remain hidden.</div></div>
        <div class="progress-track"><span style="width:${((game.currentRound - 1) / game.rounds) * 100}%"></span></div>
        <button class="btn btn-primary" id="offline-next-round" type="button">${game.currentRound < game.rounds ? `Complete clue round ${game.currentRound} &amp; continue` : `Complete clue round ${game.currentRound} &amp; start voting`}</button>
        <div class="section"><button class="btn btn-quiet" id="offline-cancel" type="button">Cancel round</button></div>
      </section>`;
    $("#offline-next-round").addEventListener("click", () => {
      if (game.currentRound < game.rounds) game.currentRound += 1;
      else { game.phase = "voting"; game.currentVoterIndex = 0; }
      renderOffline();
    });
    $("#offline-cancel").addEventListener("click", () => {
      state.offline = null;
      renderOfflineSetup();
    });
    return;
  }

  if (game.phase === "voting") {
    const voter = game.players[game.currentVoterIndex];
    $("#view").innerHTML = `
      <section class="panel center">
        <div class="eyebrow">Offline mode · Secret vote ${game.currentVoterIndex + 1} of ${game.players.length}</div>
        <h2>Pass the phone to</h2>
        <div class="offline-current-player">${escapeHTML(voter.name)}</div>
        <p class="lead">Choose who you think is the Imposter. Your vote is private; don't show the screen to anyone else.</p>
        <div class="vote-grid">${game.players.filter((player) => player.id !== voter.id).map((player) => `<button type="button" class="vote-card" data-local-vote="${escapeHTML(player.id)}"><span>${escapeHTML(player.name)}</span><small>Vote for this player</small></button>`).join("")}</div>
        <div class="section"><button class="btn btn-quiet" id="offline-cancel" type="button">Cancel round</button></div>
      </section>`;
    $("#view").querySelectorAll("[data-local-vote]").forEach((button) => button.addEventListener("click", () => {
      game.votes[voter.id] = button.dataset.localVote;
      if (game.currentVoterIndex < game.players.length - 1) game.currentVoterIndex += 1;
      else game.phase = "vote_results";
      renderOffline();
    }));
    $("#offline-cancel").addEventListener("click", () => {
      state.offline = null;
      renderOfflineSetup();
    });
    return;
  }

  const voteCounts = Object.entries(game.votes).reduce((counts, [, targetId]) => {
    counts[targetId] = (counts[targetId] || 0) + 1;
    return counts;
  }, {});
  const voteRanking = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
  const topVotes = voteRanking.length ? voteRanking[0][1] : 0;
  const mostVoted = voteRanking.filter(([, count]) => count === topVotes).map(([id]) => game.players.find((player) => player.id === id)).filter(Boolean);

  if (game.phase === "vote_results") {
    $("#view").innerHTML = `
      <section class="panel wide">
        <div class="eyebrow">Offline mode · Voting complete</div>
        <h2>Who did the group suspect?</h2>
        <p class="inline-note">The secret votes are counted. The host can now reveal the word and the actual Imposter.</p>
        <div class="section"><div class="section-head"><h3>Vote tally</h3><span class="pill">${game.players.length} votes</span></div><div class="progress-list">${voteRanking.map(([id, count]) => { const voted = game.players.find((player) => player.id === id); return `<div class="progress-item"><span>${escapeHTML(voted?.name || "Player")}</span><strong>${count} vote${count === 1 ? "" : "s"}</strong></div>`; }).join("")}</div>${mostVoted.length > 1 ? `<p class="inline-note">Tie between ${mostVoted.map((player) => escapeHTML(player.name)).join(", ")}.</p>` : mostVoted.length ? `<p class="inline-note">Most votes: ${escapeHTML(mostVoted[0].name)}.</p>` : ""}</div>
        <button class="btn btn-primary" id="offline-end-round" type="button">Reveal secret word &amp; Imposter</button>
        <div class="section"><button class="btn btn-quiet" id="offline-cancel" type="button">Cancel round</button></div>
      </section>`;
    $("#offline-end-round").addEventListener("click", () => { game.phase = "finished"; renderOffline(); });
    $("#offline-cancel").addEventListener("click", () => { state.offline = null; renderOfflineSetup(); });
    return;
  }

  const imposters = game.players.filter((player) => game.imposterIds.includes(player.id));
  $("#view").innerHTML = `
    <section class="panel wide">
      <div class="eyebrow">Offline round · Revealed</div>
      <div class="result-banner imposters"><h2>Round revealed.</h2><p>Here is the secret word and the player(s) who were the Imposter.</p></div>
      <div class="center"><div class="role-label">The secret word was</div><div class="result-word">${escapeHTML(game.word)}</div><p class="inline-note">Topic: ${escapeHTML(game.topic)}</p></div>
      <div class="section"><div class="section-head"><h3>The Imposter${imposters.length > 1 ? "s" : ""}</h3><span class="pill">${imposters.length} player${imposters.length === 1 ? "" : "s"}</span></div>${playerCards(imposters)}</div>
      <div class="section"><div class="section-head"><h3>Vote tally</h3></div><div class="progress-list">${voteRanking.map(([id, count]) => { const voted = game.players.find((player) => player.id === id); return `<div class="progress-item"><span>${escapeHTML(voted?.name || "Player")}</span><strong>${count} vote${count === 1 ? "" : "s"}</strong></div>`; }).join("")}</div></div>
      <div class="section"><div class="section-head"><h3>Everyone who played</h3></div>${playerCards(game.players)}</div>
      <div class="section button-row"><button class="btn btn-primary" id="offline-rematch" type="button">Play another round</button><button class="btn btn-quiet" id="offline-back-setup" type="button">Back to setup</button></div>
    </section>`;
  $("#offline-rematch").addEventListener("click", startOfflineRound);
  $("#offline-back-setup").addEventListener("click", () => {
    state.offline = null;
    renderOfflineSetup();
  });
}

function attachOfflinePassingHandlers(player) {
  const holdButton = $("#offline-hold");
  const roleCard = $("#offline-role-card");
  const nextButton = $("#offline-next");
  const game = state.offline;
  let held = false;

  const showRole = (event) => {
    if (held) return;
    held = true;
    event?.preventDefault?.();
    game.revealVisible = true;
    roleCard.innerHTML = offlineRoleCard(player);
    roleCard.hidden = false;
    holdButton.textContent = "Release to hide your role";
    holdButton.classList.add("is-holding");
  };
  const hideRole = () => {
    if (!held) return;
    held = false;
    game.revealVisible = false;
    game.seenPlayerIds = [...new Set([...game.seenPlayerIds, player.id])];
    roleCard.hidden = true;
    roleCard.innerHTML = "";
    holdButton.textContent = "Role hidden · You have viewed it";
    holdButton.classList.remove("is-holding");
    nextButton.disabled = false;
    const count = $(".progress-track span");
    if (count) count.style.width = `${(game.seenPlayerIds.length / game.players.length) * 100}%`;
    const pill = $(".section .pill");
    if (pill) pill.textContent = `${game.seenPlayerIds.length} / ${game.players.length}`;
  };

  holdButton.addEventListener("pointerdown", (event) => {
    showRole(event);
    try { holdButton.setPointerCapture(event.pointerId); } catch { /* Not supported by every browser. */ }
  });
  holdButton.addEventListener("pointerup", hideRole);
  holdButton.addEventListener("pointercancel", hideRole);
  holdButton.addEventListener("lostpointercapture", hideRole);
  holdButton.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") showRole(event);
  });
  holdButton.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") hideRole();
  });
  holdButton.addEventListener("contextmenu", (event) => event.preventDefault());

  nextButton.addEventListener("click", () => {
    if (!game.seenPlayerIds.includes(player.id)) return showToast("Press and hold to view your role first.");
    if (game.currentPlayerIndex < game.players.length - 1) {
      game.currentPlayerIndex += 1;
      renderOffline();
    } else {
      game.phase = "playing";
      renderOffline();
    }
  });
  $("#offline-cancel").addEventListener("click", () => {
    state.offline = null;
    renderOfflineSetup();
  });
}

function render() {
  if (state.offline) return renderOffline();
  if (!state.code || !state.room) return renderHome();
  const phase = state.room.phase;
  let html;
  if (phase === "lobby") html = lobbyView();
  else if (phase === "reveal") html = revealView();
  else if (phase === "clues") html = clueView();
  else if (phase === "voting") html = votingView();
  else if (phase === "voting_tie") html = tieView();
  else if (phase === "final_guess") html = guessView();
  else if (phase === "finished") html = finishedView();
  else html = '<section class="panel center"><div class="loader"></div></section>';
  $("#view").innerHTML = html;
  attachRoomHandlers();
}

function attachRoomHandlers() {
  $("#discord-invite")?.addEventListener("click", async () => {
    try {
      await state.discord.sdk.commands.openInviteDialog();
    } catch (error) {
      showToast(error.message || "Discord invite dialog could not be opened.");
    }
  });

  $("#copy-code")?.addEventListener("click", async () => {
    const link = `${location.origin}/?room=${state.code}`;
    try { await navigator.clipboard.writeText(link); showToast("Invite link copied."); }
    catch { showToast(`Room code: ${state.code}`); }
  });

  $("#topic-grid")?.addEventListener("change", () => {
    const count = $("#topic-grid").querySelectorAll("input:checked").length;
    $("#topic-count").textContent = `${count} selected`;
  });

  $("#start-game")?.addEventListener("click", async () => {
    const topics = [...$("#topic-grid").querySelectorAll("input:checked")].map((input) => input.value);
    if (!topics.length) return showToast("Choose at least one topic.");
    try {
      await api(`/api/rooms/${state.code}/start`, { method: "POST", body: {
        topics,
        imposterCount: Number($("#imposter-count").value),
        rounds: Number($("#round-count").value),
        imposterHint: $("#imposter-hint").checked
      } });
      await refreshRoom(true);
    } catch (error) { showToast(error.message); }
  });

  $("#leave-room")?.addEventListener("click", () => {
    clearSession();
    history.replaceState({}, "", "/");
    renderHome();
  });

  $("#reveal-card")?.addEventListener("click", () => {
    state.revealVisible = !state.revealVisible;
    render();
  });

  $("#ready-up")?.addEventListener("click", async () => {
    try { await api(`/api/rooms/${state.code}/ready`, { method: "POST", body: {} }); await refreshRoom(true); }
    catch (error) { showToast(error.message); }
  });

  $("#clue-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const clue = $("#clue-input").value.trim();
    try { await api(`/api/rooms/${state.code}/clue`, { method: "POST", body: { clue } }); await refreshRoom(true); }
    catch (error) { showToast(error.message); }
  });

  $("[data-vote]") && $("#view").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-vote]");
    if (!button) return;
    button.disabled = true;
    try { await api(`/api/rooms/${state.code}/vote`, { method: "POST", body: { targetId: button.dataset.vote } }); await refreshRoom(true); }
    catch (error) { showToast(error.message); button.disabled = false; }
  });

  $("[data-tiebreak]") && $("#view").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-tiebreak]");
    if (!button) return;
    try { await api(`/api/rooms/${state.code}/tie-break`, { method: "POST", body: { targetId: button.dataset.tiebreak } }); await refreshRoom(true); }
    catch (error) { showToast(error.message); }
  });

  $("#guess-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const guess = $("#guess-input").value.trim();
    try { await api(`/api/rooms/${state.code}/guess`, { method: "POST", body: { guess } }); await refreshRoom(true); }
    catch (error) { showToast(error.message); }
  });

  $("#rematch")?.addEventListener("click", async () => {
    try { await api(`/api/rooms/${state.code}/reset`, { method: "POST", body: {} }); await refreshRoom(true); }
    catch (error) { showToast(error.message); }
  });

  $("#exit-room")?.addEventListener("click", () => {
    clearSession();
    history.replaceState({}, "", "/");
    renderHome();
  });
}

async function setupDiscordActivity() {
  if (!inDiscordFrame) return;
  try {
    const config = await api("/api/discord/config", { auth: false });
    if (!config.enabled || !config.clientId) throw new Error("Discord Activity is not configured yet. Add your Application Client ID and deploy the Worker.");

    const { DiscordSDK } = await import("/discord-sdk.js");
    const sdk = new DiscordSDK(config.clientId);
    await sdk.ready();

    const { code } = await sdk.commands.authorize({
      client_id: config.clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "applications.commands"]
    });
    const tokenData = await api("/api/discord/token", { method: "POST", body: { code }, auth: false });
    const auth = await sdk.commands.authenticate({ access_token: tokenData.access_token });
    if (!auth?.user?.id) throw new Error("Discord did not return your authenticated user.");

    state.discord = { sdk, user: auth.user, instanceId: discordInstanceId };

    // Every user opening this same Discord Activity instance is placed into the
    // same game room. The Worker verifies the OAuth token with Discord first.
    const entered = await api("/api/discord/enter", {
      method: "POST",
      auth: false,
      body: { instanceId: sdk.instanceId, accessToken: tokenData.access_token }
    });
    setSession(entered);
    await refreshRoom(true);
  } catch (error) {
    state.discordError = error.message || "Discord Activity connection failed.";
  }
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await loadTopics();
  await setupDiscordActivity();
  if (inDiscordFrame && state.code) return;
  const queryCode = new URLSearchParams(location.search).get("room");
  const session = saved;
  if (session?.code && session?.token) {
    state.code = session.code;
    state.token = session.token;
    state.player = session.player;
    try {
      await refreshRoom(true);
      connectSocket();
      startPolling();
      return;
    } catch {
      clearSession();
    }
  }
  if (queryCode) history.replaceState({}, "", `/?room=${encodeURIComponent(queryCode.toUpperCase())}`);
  renderHome();
}

boot();
