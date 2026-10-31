const $ = (selector, root = document) => root.querySelector(selector);
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
  pollTimer: null
};

const saved = (() => {
  try { return JSON.parse(localStorage.getItem("imposter-session") || "null"); }
  catch { return null; }
})();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function saveSession() {
  localStorage.setItem("imposter-session", JSON.stringify({ code: state.code, token: state.token, player: state.player }));
}

function clearSession() {
  localStorage.removeItem("imposter-session");
  state.code = state.token = state.player = state.room = state.me = null;
  state.lastSignature = "";
  state.revealVisible = false;
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
  try {
    const data = await api("/api/topics", { auth: false });
    state.topics = data.topics || [];
  } catch (error) {
    showToast("Couldn't load topics. Refresh the page.");
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
      </div>
      <p class="inline-note" style="margin:22px auto 0">3–12 players · No account required · Works on phones and desktops</p>
    </section>`;

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
        <div><div class="eyebrow">Waiting room</div><h2>Bring your people in.</h2><p class="inline-note">Share the code. The game starts when everyone is ready.</p></div>
        <div><div class="field-label">ROOM CODE</div><button class="room-code" id="copy-code" type="button">${escapeHTML(room.code)} <span>↗</span></button></div>
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
        <div class="setting-row"><span>Give the Imposter a category hint</span><label class="switch"><input id="imposter-hint" type="checkbox" ${settings.imposterHint !== false ? "checked" : ""}><span>On</span></label></div>
        <p class="inline-note" style="margin:13px 0 0">Every selected topic is eligible. The secret word is chosen randomly when the host starts the game.</p>
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

function clueBoard() {
  const clues = state.room.clues || [];
  return clues.length ? `<div class="clue-list">${clues.map((clue) => `<div class="clue-card"><span>${escapeHTML(clue.playerName)}</span><strong>${escapeHTML(clue.text)}</strong></div>`).join("")}</div>` : '<div class="muted-block">No clues submitted yet.</div>';
}

function clueView() {
  const me = state.me;
  const room = state.room;
  const submitted = me.hasClue;
  return `<section class="panel wide">
    <div class="eyebrow">Round 1 · Clue time</div><h2>Say one word.</h2><p class="inline-note">Give a clue connected to your secret word. Don't make it too obvious. The Imposter is listening.</p>
    ${submitted ? `<div class="word-card"><div class="role-label">Your clue is locked in</div><div class="secret-word">${escapeHTML(me.clue)}</div><div class="word-hint">Waiting for the remaining players.</div></div>` : `<form id="clue-form" class="form-stack" style="margin:20px 0 0"><div><label class="field-label" for="clue-input">Your one-word clue</label><input class="input" id="clue-input" maxlength="24" placeholder="Type one word…" required autocomplete="off"></div><button class="btn btn-primary" type="submit">Submit clue</button></form>`}
    <div class="section"><div class="section-head"><h3>Clues submitted</h3><span class="pill">${room.clueCount} / ${room.players.length}</span></div>${clueBoard()}</div>
  </section>`;
}

function votingView() {
  const me = state.me;
  const room = state.room;
  return `<section class="panel wide">
    <div class="eyebrow">Round 2 · Discussion &amp; vote</div><h2>Who is the Imposter?</h2><p class="inline-note">Review the clues, discuss with your group, then vote for the player you suspect. You cannot vote for yourself.</p>
    ${clueBoard()}
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
    <div class="section"><div class="section-head"><h3>All clues</h3></div>${clueBoard()}</div>
    ${result.votes?.length ? `<div class="section"><div class="section-head"><h3>Voting record</h3></div><div class="progress-list">${result.votes.map((vote) => `<div class="progress-item"><span>${escapeHTML(vote.voterName)}</span><span class="status-wait">voted for ${escapeHTML(vote.targetName)}</span></div>`).join("")}</div></div>` : ""}
    <div class="section button-row">${state.me.player.isHost ? '<button class="btn btn-primary" id="rematch">Play again</button>' : '<div class="muted-block" style="flex:1">Waiting for the host to start a rematch.</div>'}<button class="btn btn-quiet" id="exit-room">Exit room</button></div>
  </section>`;
}

function render() {
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

async function boot() {
  await loadTopics();
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
