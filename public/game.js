function qs(name) { return new URLSearchParams(location.search).get(name); }

const connectScreen = document.getElementById("connect-screen");
const connectBtn = document.getElementById("connect-btn");
const connectError = document.getElementById("connect-error");
const stakePresets = document.getElementById("stake-presets");
const stakeCustom = document.getElementById("stake-custom");
const stakeLabel = document.getElementById("stake-label");

const lobbyScreen = document.getElementById("lobby-screen");
const lobbyGreeting = document.getElementById("lobby-greeting");
const lobbyCreate = document.getElementById("lobby-create");
const lobbyShare = document.getElementById("lobby-share");
const createRoomBtn = document.getElementById("create-room-btn");
const shareLink = document.getElementById("share-link");
const inviteQrCanvas = document.getElementById("invite-qr");
const copyLinkBtn = document.getElementById("copy-link-btn");
const joinCodeInput = document.getElementById("join-code-input");
const joinRoomBtn = document.getElementById("join-room-btn");
const lobbyError = document.getElementById("lobby-error");
const challengeHandleInput = document.getElementById("challenge-handle-input");
const challengeBtn = document.getElementById("challenge-btn");
const lobbyShareLabel = document.getElementById("lobby-share-label");
const lobbyShareSub = document.getElementById("lobby-share-sub");

const gameScreen = document.getElementById("game-screen");
const p1NameEl = document.getElementById("p1-name");
const p2NameEl = document.getElementById("p2-name");
const potAmountEl = document.getElementById("pot-amount");
const rallyCountEl = document.getElementById("rally-count");
const ledgerLinesEl = document.getElementById("ledger-lines");
const waitingOverlay = document.getElementById("waiting-overlay");
const startOverlay = document.getElementById("start-overlay");
const touchUpBtn = document.getElementById("touch-up");
const touchDownBtn = document.getElementById("touch-down");
const controlsHint = document.getElementById("controls-hint");
const pausedOverlay = document.getElementById("paused-overlay");
const pausedText = document.getElementById("paused-text");

const gameoverModal = document.getElementById("gameover-modal");
const winnerHeading = document.getElementById("winner-heading");
const finalRallyEl = document.getElementById("final-rally");
const finalPotEl = document.getElementById("final-pot");
const finalTxidEl = document.getElementById("final-txid");
const leaderboardListEl = document.getElementById("leaderboard-list");
const playAgainBtn = document.getElementById("play-again-btn");

const canvas = document.getElementById("court");
const ctx = canvas.getContext("2d");
const PADDLE_W = 12, PADDLE_H = 90, BALL_R = 8;

let socket = null;
let mySlot = null;
let currentSessionId = null;
let latestState = null;

(function boot() {
  const session = qs("session");
  const roomFromUrl = qs("room");
  const authError = qs("auth_error");

  connectBtn.href = "/auth/handcash/login" + (roomFromUrl ? `?room=${roomFromUrl}` : "");
  if (authError) connectError.textContent = "Couldn't connect HandCash. Please try again.";

  if (session) {
    currentSessionId = session;
    showLobby(roomFromUrl);
  }
})();

function showLobby(autoJoinRoom) {
  connectScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  if (autoJoinRoom) {
    lobbyGreeting.textContent = `Joining room ${autoJoinRoom}…`;
    lobbyCreate.classList.add("hidden");
    joinRoom(autoJoinRoom);
  } else {
    lobbyGreeting.textContent = "Connected. Create a room or join one.";
  }
}

function ensureSocket() {
  if (socket) return socket;
  socket = io();

  socket.on("joined", (data) => {
    mySlot = data.slot;
    lobbyScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    controlsHint.textContent = mySlot === "p1" ? "W / S or the buttons below to move" : "\u2191 / \u2193 or the buttons below to move";
  });

  socket.on("join_error", ({ message }) => {
    lobbyError.textContent = message;
  });

  socket.on("state", (s) => {
    latestState = s;
    renderHud(s);
    renderLedger(s.ledger);
    const full = s.players.length === 2;
    waitingOverlay.classList.toggle("hidden", full);
    startOverlay.classList.toggle("hidden", !full || s.started);
  });

  socket.on("payment_failed", ({ slot, message }) => {
    pausedText.textContent = `Payment failed for ${slot.toUpperCase()}: ${message} — point over`;
    pausedOverlay.classList.remove("hidden");
    setTimeout(() => pausedOverlay.classList.add("hidden"), 3000);
  });

  socket.on("game_over", (data) => {
    winnerHeading.textContent = `${data.winner} WINS`;
    finalRallyEl.textContent = data.rally;
    finalPotEl.textContent = `${data.potSats.toLocaleString()} sats`;
    finalTxidEl.textContent = data.payoutTxid ? data.payoutTxid.slice(0, 20) + "\u2026" : "\u2014";
    renderLeaderboard(data.leaderboard);
    gameoverModal.classList.remove("hidden");
  });

  socket.on("opponent_left", () => {
    pausedText.textContent = "Opponent disconnected.";
    pausedOverlay.classList.remove("hidden");
  });

  return socket;
}

function joinRoom(roomCode) {
  ensureSocket().emit("join_room", { sessionId: currentSessionId, roomCode });
}

function renderInviteQr(url) {
  if (window.QRCode) {
    QRCode.toCanvas(inviteQrCanvas, url, { width: 180, margin: 1 }, (err) => {
      if (err) console.error("QR render failed:", err);
    });
  }
}

let selectedStake = 1000;
stakePresets.querySelectorAll(".stake-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedStake = parseInt(btn.dataset.stake, 10);
    stakeCustom.value = "";
    stakePresets.querySelectorAll(".stake-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});
stakeCustom.addEventListener("input", () => {
  const v = parseInt(stakeCustom.value, 10);
  if (v > 0) {
    selectedStake = v;
    stakePresets.querySelectorAll(".stake-btn").forEach((b) => b.classList.remove("active"));
  }
});
stakePresets.querySelector('[data-stake="1000"]').classList.add("active");

challengeBtn.addEventListener("click", async () => {
  const toHandle = challengeHandleInput.value.trim();
  if (!toHandle) {
    lobbyError.textContent = "Enter a HandCash handle to challenge.";
    return;
  }
  lobbyError.textContent = "";
  challengeBtn.disabled = true;
  challengeBtn.textContent = "SENDING…";
  try {
    const res = await fetch("/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, toHandle, hitFeeSats: selectedStake }),
    });
    const data = await res.json();
    if (!res.ok) {
      lobbyError.textContent = data.error || "Couldn't send that challenge.";
      return;
    }
    lobbyShareLabel.textContent = `Challenge sent to $${toHandle}! Now send them this link too:`;
    lobbyShareSub.textContent = `The payment note only carries the room code (HandCash notes are short) -- text them the link, or have them scan the QR code.`;
    shareLink.value = data.joinUrl;
    renderInviteQr(data.joinUrl);
    lobbyShare.classList.remove("hidden");
    lobbyCreate.classList.add("hidden");
    joinRoom(data.code);
  } finally {
    challengeBtn.disabled = false;
    challengeBtn.textContent = "CHALLENGE";
  }
});

createRoomBtn.addEventListener("click", async () => {
  lobbyError.textContent = "";
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hitFeeSats: selectedStake }),
  });
  const { code } = await res.json();
  lobbyShareLabel.textContent = "Send this link to your opponent:";
  lobbyShareSub.textContent = "Waiting for them to join\u2026";
  shareLink.value = `${location.origin}/${code}`;
  renderInviteQr(shareLink.value);
  lobbyShare.classList.remove("hidden");
  lobbyCreate.classList.add("hidden");
  joinRoom(code);
});

copyLinkBtn.addEventListener("click", () => {
  shareLink.select();
  navigator.clipboard?.writeText(shareLink.value);
});

joinRoomBtn.addEventListener("click", () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) return;
  lobbyError.textContent = "";
  joinRoom(code);
});
joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoomBtn.click(); });

playAgainBtn.addEventListener("click", () => {
  location.href = `/?session=${currentSessionId}`;
});

const keys = { up: false, down: false };

function setKey(dir, value) {
  keys[dir] = value;
  if (mySlot) socket.emit("input", keys);
}

function tryServe() {
  if (mySlot && latestState && latestState.players.length === 2 && !latestState.started) {
    socket.emit("serve");
  }
}
startOverlay.addEventListener("click", tryServe);

touchUpBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); setKey("up", true); });
touchUpBtn.addEventListener("pointerup", (e) => { e.preventDefault(); setKey("up", false); });
touchUpBtn.addEventListener("pointerleave", () => setKey("up", false));
touchUpBtn.addEventListener("pointercancel", () => setKey("up", false));

touchDownBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); setKey("down", true); });
touchDownBtn.addEventListener("pointerup", (e) => { e.preventDefault(); setKey("down", false); });
touchDownBtn.addEventListener("pointerleave", () => setKey("down", false));
touchDownBtn.addEventListener("pointercancel", () => setKey("down", false));

window.addEventListener("keydown", (e) => {
  if (!mySlot) return;
  if (e.code === "Space") {
    e.preventDefault();
    tryServe();
  }
  const isMoveKey =
    (mySlot === "p1" && (e.code === "KeyW" || e.code === "KeyS")) ||
    (mySlot === "p2" && (e.code === "ArrowUp" || e.code === "ArrowDown"));
  if (!isMoveKey) return;
  e.preventDefault();
  if (e.code === "KeyW" || e.code === "ArrowUp") setKey("up", true);
  if (e.code === "KeyS" || e.code === "ArrowDown") setKey("down", true);
});
window.addEventListener("keyup", (e) => {
  if (!mySlot) return;
  if (e.code === "KeyW" || e.code === "ArrowUp") setKey("up", false);
  if (e.code === "KeyS" || e.code === "ArrowDown") setKey("down", false);
});

function renderHud(s) {
  const p1 = s.players.find((p) => p.slot === "p1");
  const p2 = s.players.find((p) => p.slot === "p2");
  p1NameEl.textContent = p1 ? p1.name : "\u2014";
  p2NameEl.textContent = p2 ? p2.name : "\u2014";
  potAmountEl.textContent = s.pot.toLocaleString();
  rallyCountEl.textContent = s.rally;
  stakeLabel.textContent = s.hitFeeSats?.toLocaleString() ?? "0";
}

function renderLedger(ledger) {
  ledgerLinesEl.innerHTML = "";
  ledger.forEach((e) => {
    const line = document.createElement("div");
    line.className = "ledger-line";
    line.innerHTML = `<span class="dim">${(e.txid || "").slice(0, 12)}\u2026</span> <span class="amt">+${e.amountSats} sats</span> <span class="dim">from</span> ${e.from} <span class="dim">\u2192 pot \u00b7 rally #${e.rally}</span>`;
    ledgerLinesEl.appendChild(line);
  });
}

function renderLeaderboard(list) {
  leaderboardListEl.innerHTML = "";
  list.slice(0, 10).forEach((entry, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>#${i + 1} ${entry.winner}</span><span>${entry.rally} hits \u00b7 ${entry.potSats} sats</span>`;
    leaderboardListEl.appendChild(li);
  });
}

function draw() {
  requestAnimationFrame(draw);
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#232b33";
  ctx.setLineDash([6, 10]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);

  if (!latestState) return;
  const { paddles, ball } = latestState;

  ctx.fillStyle = "#3ddc84";
  ctx.fillRect(10, paddles.p1, PADDLE_W, PADDLE_H);
  ctx.fillRect(W - PADDLE_W - 10, paddles.p2, PADDLE_W, PADDLE_H);

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = "#f4b93e";
  ctx.fill();
}
draw();
