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

const joinConfirmModal = document.getElementById("join-confirm-modal");
const jcCode = document.getElementById("jc-code");
const jcSats = document.getElementById("jc-sats");
const jcUsd = document.getElementById("jc-usd");
const jcFee = document.getElementById("jc-fee");
const jcMode = document.getElementById("jc-mode");
const jcBalance = document.getElementById("jc-balance");
const jcHits = document.getElementById("jc-hits");
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
const touchUpBtn = document.getElementById("touch-up");
const touchDownBtn = document.getElementById("touch-down");
const controlsHint = document.getElementById("controls-hint");
const pausedOverlay = document.getElementById("paused-overlay");
const pausedText = document.getElementById("paused-text");
const topupOverlay = document.getElementById("topup-overlay");
const topupText = document.getElementById("topup-text");
const topupRetryBtn = document.getElementById("topup-retry-btn");

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
  jcUsd.textContent = "\u2014";
  jcFee.textContent = "\u2026";
  jcMode.textContent = "\u2026";
  jcBalance.textContent = "\u2026";
  jcHits.textContent = "\u2014";
  jcError.textContent = "";
  joinConfirmModal.classList.remove("hidden");

  try {
    const infoRes = await fetch(`/api/room-info/${pendingJoinCode}`);
    const info = await infoRes.json();
    if (!infoRes.ok) {
      jcError.textContent = info.error || "That room code doesn't exist.";
      return;
    }
    jcSats.textContent = `${info.hitFeeSats.toLocaleString()} sats`;
    jcUsd.textContent = usdEstimate(info.hitFeeSats).trim() || "\u2014";
    jcFee.textContent = `${info.feePercent}%`;
    jcMode.textContent = oofModeLabel(info.outOfFundsMode);

    let balanceSats = null;
    try {
      const balRes = await fetch(`/api/balance?sessionId=${encodeURIComponent(currentSessionId)}`);
      const bal = await balRes.json();
      if (balRes.ok) balanceSats = bal.sats;
    } catch {}

    if (balanceSats != null) {
      jcBalance.textContent = `${balanceSats.toLocaleString()} sats${usdEstimate(balanceSats)}`;
      jcHits.textContent = `~${Math.floor(balanceSats / info.hitFeeSats)} hits`;
    } else {
      jcBalance.textContent = "Unavailable";
      jcHits.textContent = "\u2014";
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
    mySlot = data.slot;
    localStorage.removeItem(PENDING_ROOM_KEY);
    lobbyScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    controlsHint.textContent = mySlot === "p1" ? "W / S or the buttons below to move" : "\u2191 / \u2193 or the buttons below to move";
  });

  socket.on("join_error", ({ message }) => {
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

    if (armed && full && bothReady &&
