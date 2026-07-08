function qs(name) { return new URLSearchParams(location.search).get(name); }

const connectScreen = document.getElementById("connect-screen");
const connectBtn = document.getElementById("connect-btn");
const connectError = document.getElementById("connect-error");
const stakeSlider = document.getElementById("stake-slider");
const stakeCustomInput = document.getElementById("stake-custom-input");
const stakeLevelLabel = document.getElementById("stake-level-label");
const stakeSatsLabel = document.getElementById("stake-sats-label");
const stakeFeeLabel = document.getElementById("stake-fee-label");
const stakeUsdLabel = document.getElementById("stake-usd-label");
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

const globalLoading = document.getElementById("global-loading");
const globalLoadingText = document.getElementById("global-loading-text");
function showLoading(text) {
  globalLoadingText.textContent = text || "Loading\u2026";
  globalLoading.classList.remove("hidden");
}
function hideLoading() {
  globalLoading.classList.add("hidden");
}

const joinConfirmModal = document.getElementById("join-confirm-modal");
const jcCode = document.getElementById("jc-code");
const jcSats = document.getElementById("jc-sats");
const jcFee = document.getElementById("jc-fee");
const jcMode = document.getElementById("jc-mode");
const jcBalance = document.getElementById("jc-balance");
const jcError = document.getElementById("jc-error");
const jcAcceptBtn = document.getElementById("jc-accept-btn");
const jcCancelBtn = document.getElementById("jc-cancel-btn");

const gameScreen = document.getElementById("game-screen");
const p1NameEl = document.getElementById("p1-name");
const p2NameEl = document.getElementById("p2-name");
const potAmountEl = document.getElementById("pot-amount");
const rallyCountEl = document.getElementById("rally-count");
const ledgerLinesEl = document.getElementById("ledger-lines");
const waitingOverlay = document.getElementById("waiting-overlay");
const startOverlay = document.getElementById("start-overlay");
const serveHint = document.getElementById("serve-hint");
const powerupBanner = document.getElementById("powerup-banner");
const powerupBtn = document.getElementById("powerup-btn");
const p1EffectEl = document.getElementById("p1-effect");
const p2EffectEl = document.getElementById("p2-effect");

const POWERUP_LABELS = {
  shrink: "\ud83d\udd3b Shrink Ray",
  reverse: "\ud83d\udd04 Reverse Controls",
  speedup: "\u26a1 Speed Surge",
  grow: "\ud83d\udee1\ufe0f Big Paddle",
  multiball: "\u26aa Multi-Ball",
  slowball: "\ud83d\udc0c Slow Ball",
};
const NEGATIVE_POWERUP_TYPES = new Set(["shrink", "reverse", "speedup"]);
const touchUpBtn = document.getElementById("touch-up");
const touchDownBtn = document.getElementById("touch-down");
const controlsHint = document.getElementById("controls-hint");
const pausedOverlay = document.getElementById("paused-overlay");
const pausedText = document.getElementById("paused-text");
const topupOverlay = document.getElementById("topup-overlay");
const topupText = document.getElementById("topup-text");
const topupRetryBtn = document.getElementById("topup-retry-btn");
const topupCancelBtn = document.getElementById("topup-cancel-btn");

const gameoverModal = document.getElementById("gameover-modal");
const winnerHeading = document.getElementById("winner-heading");
const finalRallyEl = document.getElementById("final-rally");
const finalPotEl = document.getElementById("final-pot");
const finalTxidEl = document.getElementById("final-txid");
const payoutFailedNote = document.getElementById("payout-failed-note");
const leaderboardListEl = document.getElementById("leaderboard-list");
const rematchBtn = document.getElementById("rematch-btn");
const playAgainBtn = document.getElementById("play-again-btn");

const canvas = document.getElementById("court");
const ctx = canvas.getContext("2d");
const PADDLE_W = 12, PADDLE_H = 90, BALL_R = 8;

let socket = null;
let mySlot = null;
let currentSessionId = null;
let latestState = null;

const SESSION_STORAGE_KEY = "satoshiPongSessionId";
const PENDING_ROOM_KEY = "satoshiPongPendingRoom";
const PENDING_CHALLENGE_KEY = "satoshiPongPendingChallenge";

let usdPerBsv = null;
fetch("/api/price").then((r) => r.json()).then((d) => { usdPerBsv = d.usdPerBsv; renderFromSlider(); }).catch(() => {});

function usdEstimate(sats) {
  if (!usdPerBsv) return "";
  const usd = (sats / 100000000) * usdPerBsv;
  return ` (~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)})`;
}

(function boot() {
  const sessionFromUrl = qs("session");
  const authError = qs("auth_error");

  const roomFromUrl = qs("room");
  if (roomFromUrl) localStorage.setItem(PENDING_ROOM_KEY, roomFromUrl);
  const pendingRoom = roomFromUrl || localStorage.getItem(PENDING_ROOM_KEY);

  if (sessionFromUrl) {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionFromUrl);
  }
  const session = sessionFromUrl || localStorage.getItem(SESSION_STORAGE_KEY);

  connectBtn.href = "/auth/handcash/login" + (pendingRoom ? `?room=${pendingRoom}` : "");
  if (authError) connectError.textContent = "Couldn't connect HandCash. Please try again.";

  if (session) {
    currentSessionId = session;
    showLobby(pendingRoom);
  }
})();

function showLobby(autoJoinRoom) {
  connectScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  if (autoJoinRoom) {
    lobbyGreeting.textContent = "Review this game before joining:";
    lobbyCreate.classList.add("hidden");
    showJoinConfirm(autoJoinRoom);
  } else {
    lobbyGreeting.textContent = "Connected. Create a room or join one.";
    const pendingChallenge = localStorage.getItem(PENDING_CHALLENGE_KEY);
    if (pendingChallenge) {
      challengeHandleInput.value = pendingChallenge;
      localStorage.removeItem(PENDING_CHALLENGE_KEY);
    }
  }
}

let pendingJoinCode = null;

async function showJoinConfirm(code) {
  pendingJoinCode = code.toUpperCase();
  jcCode.textContent = pendingJoinCode;
  jcSats.textContent = "\u2026";
  jcFee.textContent = "\u2026";
  jcMode.textContent = "\u2026";
  jcBalance.textContent = "\u2026";
  jcError.textContent = "";
  joinConfirmModal.classList.remove("hidden");

  try {
    const infoRes = await fetch(`/api/room-info/${pendingJoinCode}`);
    const info = await infoRes.json();
    if (!infoRes.ok) {
      jcError.textContent = info.error || "That room code doesn't exist.";
      return;
    }
    jcSats.textContent = `${info.hitFeeSats.toLocaleString()} sats${usdEstimate(info.hitFeeSats)}`;
    jcFee.textContent = `${info.feePercent}%`;
    jcMode.textContent = oofModeLabel(info.outOfFundsMode);

    let balanceSats = null;
    try {
      const balRes = await fetch(`/api/balance?sessionId=${encodeURIComponent(currentSessionId)}`);
      const bal = await balRes.json();
      if (balRes.ok) balanceSats = bal.sats;
    } catch {}

    if (balanceSats != null) {
      const hits = Math.floor(balanceSats / info.hitFeeSats);
      jcBalance.textContent = `${balanceSats.toLocaleString()} sats (~${hits} hits)`;
    } else {
      jcBalance.textContent = "Unavailable";
    }
  } catch (err) {
    jcError.textContent = "Couldn't load room details: " + err.message;
  }
}

function oofModeLabel(mode) {
  if (mode === "draw") return "Draw (pot splits)";
  if (mode === "forfeit") return "Forfeit (lose the point)";
  return "Pause & top up";
}

jcAcceptBtn.addEventListener("click", () => {
  joinConfirmModal.classList.add("hidden");
  showLoading("Joining game\u2026");
  if (pendingJoinCode) joinRoom(pendingJoinCode);
});

jcCancelBtn.addEventListener("click", () => {
  joinConfirmModal.classList.add("hidden");
  pendingJoinCode = null;
  localStorage.removeItem(PENDING_ROOM_KEY);
  lobbyGreeting.textContent = "Connected. Create a room or join one.";
  lobbyCreate.classList.remove("hidden");
});

function ensureSocket() {
  if (socket) return socket;
  socket = io();

  socket.on("joined", (data) => {
    hideLoading();
    mySlot = data.slot;
    localStorage.removeItem(PENDING_ROOM_KEY);
    lobbyScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    controlsHint.textContent = mySlot === "p1" ? "W / S or the buttons below to move" : "\u2191 / \u2193 or the buttons below to move";
  });

  socket.on("join_error", ({ message }) => {
    hideLoading();
    if (message.includes("expired")) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      const room = qs("room") || localStorage.getItem(PENDING_ROOM_KEY);
      if (room) localStorage.setItem(PENDING_ROOM_KEY, room);
      lobbyGreeting.textContent = "Reconnecting\u2026";
      location.href = "/auth/handcash/login" + (room ? `?room=${room}` : "");
      return;
    }
    joinConfirmModal.classList.add("hidden");
    lobbyCreate.classList.remove("hidden");
    lobbyError.textContent = message;
  });

  socket.on("state", (s) => {
    latestState = s;
    renderHud(s);
    renderLedger(s.ledger);
    const full = s.players.length === 2;
    const bothReady = s.readyForRematch?.p1 && s.readyForRematch?.p2;
    const armed = !!s.armedServe;

    waitingOverlay.classList.toggle("hidden", full);
    startOverlay.classList.toggle("hidden", !full || s.started || armed || !bothReady || s.paused);

    if (armed && full && bothReady && !s.paused) {
      serveHint.classList.remove("hidden");
      serveHint.textContent = s.armedServe === mySlot
        ? "Tap or press SPACE to launch the ball"
        : "Opponent is serving\u2026";
    } else {
      serveHint.classList.add("hidden");
    }

    if (s.paused) {
      topupOverlay.classList.remove("hidden");
      topupCancelBtn.disabled = false;
      const needsTopUp = s.pausedSlot === mySlot;
      topupText.textContent = needsTopUp
        ? `Short on funds. Raise your HandCash limit or add funds, then retry.`
        : `Waiting for opponent to top up\u2026`;
      topupRetryBtn.classList.toggle("hidden", !needsTopUp);
    } else {
      topupOverlay.classList.add("hidden");
    }

    if (!gameoverModal.classList.contains("hidden") && mySlot) {
      const iAmReady = s.readyForRematch?.[mySlot];
      const opponentReady = s.readyForRematch?.[mySlot === "p1" ? "p2" : "p1"];
      if (iAmReady && !opponentReady) {
        rematchBtn.textContent = "WAITING FOR OPPONENT\u2026";
        rematchBtn.disabled = true;
      }
    }

    const held = mySlot ? s.heldPowerUp?.[mySlot] : null;
    if (held) {
      const negative = NEGATIVE_POWERUP_TYPES.has(held.type);
      powerupBtn.disabled = false;
      powerupBtn.classList.add("ready");
      powerupBtn.classList.toggle("negative", negative);
      powerupBtn.textContent = `USE: ${POWERUP_LABELS[held.type] || held.type}`;
    } else {
      powerupBtn.disabled = true;
      powerupBtn.classList.remove("ready", "negative");
      powerupBtn.textContent = "NO POWER-UP";
    }

    renderEffectBadge(p1EffectEl, s.effects?.p1);
    renderEffectBadge(p2EffectEl, s.effects?.p2);
  });

  socket.on("payment_failed", ({ slot, message }) => {
    pausedText.textContent = `Payment failed for ${slot.toUpperCase()}: ${message} — point over`;
    pausedOverlay.classList.remove("hidden");
    setTimeout(() => pausedOverlay.classList.add("hidden"), 3000);
  });

  socket.on("payment_paused", ({ slot, message }) => {
    pausedText.textContent = `${slot.toUpperCase()} couldn't cover that hit: ${message}`;
    pausedOverlay.classList.remove("hidden");
    setTimeout(() => pausedOverlay.classList.add("hidden"), 3000);
  });

  socket.on("powerup_triggered", ({ effectType, activatedBy, target, ballCount }) => {
    const who = (slot) => {
      const p = latestState?.players.find((pl) => pl.slot === slot);
      return p ? p.name : slot?.toUpperCase();
    };
    const messages = {
      speedup: `\u26a1 ${who(activatedBy)} unleashed SPEED SURGE on ${who(target)}!`,
      shrink: `\ud83d\udd3b ${who(activatedBy)} hit ${who(target)} with SHRINK RAY!`,
      reverse: `\ud83d\udd04 ${who(activatedBy)} REVERSED ${who(target)}'s controls!`,
      grow: `\ud83d\udee1\ufe0f ${who(activatedBy)} grew a BIGGER PADDLE!`,
      multiball: `\u26aa ${who(activatedBy)} unleashed MULTI-BALL! (+${ballCount} balls)`,
      slowball: `\ud83d\udc0c ${who(activatedBy)} activated SLOW BALL!`,
    };
    powerupBanner.textContent = messages[effectType] || "POWER-UP!";
    setTimeout(() => { powerupBanner.textContent = ""; }, 2200);
  });

  socket.on("powerup_collected", ({ slot, effectType }) => {
    if (slot !== mySlot) return;
    powerupBanner.textContent = `Collected: ${POWERUP_LABELS[effectType] || effectType}! Tap USE POWER-UP when ready.`;
    setTimeout(() => { powerupBanner.textContent = ""; }, 2200);
  });

  socket.on("resumed", () => {
    topupOverlay.classList.add("hidden");
  });

  socket.on("game_over", (data) => {
    if (data.draw) {
      winnerHeading.textContent = "IT'S A DRAW \u2014 POT SPLIT";
      finalRallyEl.textContent = data.rally;
      const potLabel = data.devCut > 0
        ? `${data.potSats.toLocaleString()} sats${usdEstimate(data.potSats)} (${data.splitAmount.toLocaleString()} each, ${data.devCut.toLocaleString()} fee)`
        : `${data.potSats.toLocaleString()} sats${usdEstimate(data.potSats)} (${data.splitAmount.toLocaleString()} each)`;
      finalPotEl.textContent = potLabel;
    } else {
      winnerHeading.textContent = `${data.winner} WINS`;
      finalRallyEl.textContent = data.rally;
      const potLabel = data.devCut > 0
        ? `${data.potSats.toLocaleString()} sats${usdEstimate(data.potSats)} (${data.winnerAmount.toLocaleString()} to winner, ${data.devCut.toLocaleString()} fee)`
        : `${data.potSats.toLocaleString()} sats${usdEstimate(data.potSats)}`;
      finalPotEl.textContent = potLabel;
    }
    finalTxidEl.textContent = data.payoutTxid ? data.payoutTxid.slice(0, 20) + "\u2026" : "\u2014";
    payoutFailedNote.classList.toggle("hidden", !data.payoutFailed);
    renderLeaderboard(data.leaderboard);
    rematchBtn.textContent = "REMATCH";
    rematchBtn.disabled = false;
    gameoverModal.classList.remove("hidden");
  });

  socket.on("rematch_ready", () => {
    gameoverModal.classList.add("hidden");
  });

  socket.on("opponent_left", () => {
    pausedText.textContent = "Opponent left the game. Returning to lobby\u2026";
    pausedOverlay.classList.remove("hidden");
    setTimeout(() => { location.href = `/?session=${currentSessionId}`; }, 1800);
  });

  return socket;
}function joinRoom(roomCode) {
  ensureSocket().emit("join_room", { sessionId: currentSessionId, roomCode });
}

topupRetryBtn.addEventListener("click", () => {
  topupRetryBtn.disabled = true;
  topupRetryBtn.textContent = "RETRYING\u2026";
  socket.emit("resume_after_topup");
  setTimeout(() => {
    topupRetryBtn.disabled = false;
    topupRetryBtn.textContent = "I'VE TOPPED UP \u2014 RETRY";
  }, 2000);
});

topupCancelBtn.addEventListener("click", () => {
  topupCancelBtn.disabled = true;
  socket.emit("cancel_paused_game");
});

powerupBtn.addEventListener("click", () => {
  if (powerupBtn.disabled) return;
  socket.emit("activate_powerup");
});

function renderInviteQr(url) {
  if (window.QRCode) {
    QRCode.toCanvas(inviteQrCanvas, url, { width: 180, margin: 1 }, (err) => {
      if (err) console.error("QR render failed:", err);
    });
  }
}

const oofToggle = document.getElementById("oof-toggle");
const oofDesc = document.getElementById("oof-desc");
const OOF_DESCRIPTIONS = {
  pause: "Game pauses so they can top up, then continues.",
  draw: "Pot splits evenly right away.",
  forfeit: "They lose the point immediately.",
};
let selectedOofMode = "pause";
oofToggle.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedOofMode = btn.dataset.mode;
    oofToggle.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    oofDesc.textContent = OOF_DESCRIPTIONS[selectedOofMode];
  });
});
function selectedOutOfFundsMode() {
  return selectedOofMode;
}

const STAKE_LEVELS = [
  { level: 1, sats: 1000, label: "Easy", feePercent: 10 },
  { level: 2, sats: 5000, label: "Easy+", feePercent: 9 },
  { level: 3, sats: 10000, label: "Casual", feePercent: 8 },
  { level: 4, sats: 50000, label: "Casual+", feePercent: 7 },
  { level: 5, sats: 100000, label: "Moderate", feePercent: 6 },
  { level: 6, sats: 500000, label: "Moderate+", feePercent: 5 },
  { level: 7, sats: 1000000, label: "High Stakes", feePercent: 4 },
  { level: 8, sats: 5000000, label: "High Stakes+", feePercent: 3 },
  { level: 9, sats: 10000000, label: "Whale", feePercent: 2 },
  { level: 10, sats: 100000000, label: "Max (1 BSV/hit)", feePercent: 1 },
];

function nearestStakeLevel(sats) {
  const target = Math.log(Math.max(sats, 1));
  return STAKE_LEVELS.reduce((best, lvl) =>
    Math.abs(Math.log(lvl.sats) - target) < Math.abs(Math.log(best.sats) - target) ? lvl : best
  );
}

let selectedStake = STAKE_LEVELS[0].sats;

function renderFromSlider() {
  const lvl = STAKE_LEVELS[parseInt(stakeSlider.value, 10) - 1];
  selectedStake = lvl.sats;
  stakeCustomInput.value = "";
  updateStakeLabels(lvl, lvl.sats);
}

function renderFromCustom() {
  const typed = parseInt(stakeCustomInput.value, 10);
  if (!Number.isFinite(typed) || typed <= 0) return;
  selectedStake = typed;
  const lvl = nearestStakeLevel(typed);
  stakeSlider.value = lvl.level;
  updateStakeLabels(lvl, typed);
}

function updateStakeLabels(lvl, actualSats) {
  stakeLevelLabel.textContent = `${lvl.level}. ${lvl.label}`;
  stakeSatsLabel.textContent = `${actualSats.toLocaleString()} sats / hit`;
  stakeFeeLabel.textContent = `${lvl.feePercent}% fee`;
  stakeUsdLabel.textContent = usdPerBsv ? `\u2248 ${usdEstimate(actualSats).trim()} per hit` : "";
}

stakeSlider.addEventListener("input", renderFromSlider);
stakeCustomInput.addEventListener("input", renderFromCustom);
renderFromSlider();

challengeHandleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); challengeBtn.click(); } });
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
      body: JSON.stringify({ sessionId: currentSessionId, toHandle, hitFeeSats: selectedStake, outOfFundsMode: selectedOutOfFundsMode() }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error || "Couldn't send that challenge.";
      if (errMsg.includes("expired")) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.setItem(PENDING_CHALLENGE_KEY, toHandle);
        lobbyGreeting.textContent = "Reconnecting\u2026";
        location.href = "/auth/handcash/login";
        return;
      }
      lobbyError.textContent = errMsg;
      return;
    }
    lobbyShareLabel.textContent = `Challenge sent to $${toHandle}! Now send them this link too:`;
    lobbyShareSub.textContent = `The payment note only carries the room code (HandCash notes are short) -- text them the link, or have them scan the QR code.`;
    shareLink.value = data.joinUrl;
    renderInviteQr(data.joinUrl);
    lobbyShare.classList.remove("hidden");
    lobbyCreate.classList.add("hidden");
    localStorage.setItem(PENDING_ROOM_KEY, data.code);
    joinRoom(data.code);
  } catch (err) {
    console.error("Challenge request failed:", err);
    lobbyError.textContent = "Something went wrong sending that challenge: " + err.message;
  } finally {
    challengeBtn.disabled = false;
    challengeBtn.textContent = "CHALLENGE";
  }
});

createRoomBtn.addEventListener("click", async () => {
  lobbyError.textContent = "";
  showLoading("Creating room\u2026");
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hitFeeSats: selectedStake, outOfFundsMode: selectedOutOfFundsMode() }),
  });
  const { code } = await res.json();
  lobbyShareLabel.textContent = "Send this link to your opponent:";
  lobbyShareSub.textContent = "Waiting for them to join\u2026";
  shareLink.value = `${location.origin}/${code}`;
  renderInviteQr(shareLink.value);
  lobbyShare.classList.remove("hidden");
  lobbyCreate.classList.add("hidden");
  localStorage.setItem(PENDING_ROOM_KEY, code);
  showLoading("Setting up your room\u2026");
  joinRoom(code);
});

copyLinkBtn.addEventListener("click", () => {
  shareLink.select();
  navigator.clipboard?.writeText(shareLink.value);
});

function extractRoomCode(input) {
  let s = (input || "").trim();
  if (!s) return "";
  /* If they pasted a full link (satoshipong.com/AB12CD, with or without */
  /* https://, a room=... query, etc.), pull just the code out of it. */
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const roomParamMatch = s.match(/[?&]room=([A-Z0-9]{6})/i);
  if (roomParamMatch) return roomParamMatch[1].toUpperCase();
  const parts = s.split(/[\/?#]/).filter(Boolean);
  const last = parts[parts.length - 1] || s;
  return last.toUpperCase();
}

joinRoomBtn.addEventListener("click", () => {
  const code = extractRoomCode(joinCodeInput.value);
  if (!code) return;
  lobbyError.textContent = "";
  showJoinConfirm(code);
});
joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoomBtn.click(); });

rematchBtn.addEventListener("click", () => {
  socket.emit("ready_rematch");
  rematchBtn.textContent = "WAITING FOR OPPONENT\u2026";
  rematchBtn.disabled = true;
});

playAgainBtn.addEventListener("click", () => {
  location.href = `/?session=${currentSessionId}`;
});

const keys = { up: false, down: false };

function setKey(dir, value) {
  keys[dir] = value;
  if (mySlot) socket.emit("input", keys);
}

function tryServe() {
  if (mySlot && latestState && latestState.players.length === 2 && !latestState.started && !latestState.paused) {
    socket.emit("serve");
  }
}
startOverlay.addEventListener("click", tryServe);
canvas.addEventListener("click", tryServe);

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
  if (e.code === "KeyE" && !powerupBtn.disabled) {
    e.preventDefault();
    powerupBtn.click();
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

function renderEffectBadge(el, effect) {
  if (!effect || !effect.expiresAt) {
    el.classList.add("hidden");
    return;
  }
  const remaining = Math.max(0, Math.ceil((effect.expiresAt - Date.now()) / 1000));
  if (remaining <= 0) {
    el.classList.add("hidden");
    return;
  }
  const negative = NEGATIVE_POWERUP_TYPES.has(effect.type);
  el.textContent = `${POWERUP_LABELS[effect.type] || effect.type} \u2022 ${remaining}s`;
  el.classList.remove("hidden");
  el.classList.toggle("negative", negative);
}

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

const POWERUP_ICONS = {
  speedup: "\u26a1", shrink: "\ud83d\udd3b", reverse: "\ud83d\udd04",
  grow: "\ud83d\udee1\ufe0f", multiball: "\u26aa", slowball: "\ud83d\udc0c",
};

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
  const { paddles, ball, extraBalls, paddleHeights, powerUp, effects } = latestState;
  const p1H = paddleHeights?.p1 ?? PADDLE_H;
  const p2H = paddleHeights?.p2 ?? PADDLE_H;

  const paddleColor = (effect) => {
    if (!effect) return "#3ddc84";
    return NEGATIVE_POWERUP_TYPES.has(effect.type) ? "#ff5a5a" : "#f4b93e";
  };
  ctx.fillStyle = paddleColor(effects?.p1);
  ctx.fillRect(10, paddles.p1, PADDLE_W, p1H);
  ctx.fillStyle = paddleColor(effects?.p2);
  ctx.fillRect(W - PADDLE_W - 10, paddles.p2, PADDLE_W, p2H);

  if (powerUp) {
    const negative = NEGATIVE_POWERUP_TYPES.has(powerUp.type);
    const color = negative ? "#ff5a5a" : "#f4b93e";
    ctx.beginPath();
    ctx.arc(powerUp.x, powerUp.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = negative ? "rgba(255,90,90,0.18)" : "rgba(244,185,62,0.18)";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(POWERUP_ICONS[powerUp.type] || "?", powerUp.x, powerUp.y);
    ctx.font = "bold 9px monospace";
    ctx.fillStyle = color;
    ctx.fillText((powerUp.type || "").toUpperCase(), powerUp.x, powerUp.y + 24);
  }

  ;(extraBalls || []).forEach((eb) => {
    ctx.beginPath();
    ctx.arc(eb.x, eb.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = "#7d8791";
    ctx.fill();
  });

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = "#f4b93e";
  ctx.fill();
}
draw();
