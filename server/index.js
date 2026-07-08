require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const handcash = require("./handcash");
const { createRoom, getRoom, deleteRoom, W, H } = require("./rooms");
const { addLeaderboardEntry, getLeaderboard } = require("./store");

const TICK_MS = 20;

const HOUSE_HANDLE = process.env.HANDCASH_HOUSE_HANDLE;
const HOUSE_AUTH_TOKEN = process.env.HANDCASH_HOUSE_AUTH_TOKEN;
const DEV_HANDLE = process.env.HANDCASH_DEV_HANDLE;

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

const VALID_OUT_OF_FUNDS_MODES = ["forfeit", "draw", "pause"];
function normalizeOutOfFundsMode(mode) {
  return VALID_OUT_OF_FUNDS_MODES.includes(mode) ? mode : "pause";
}

if (!process.env.HANDCASH_APP_ID || !process.env.HANDCASH_APP_SECRET) {
  console.warn("⚠️  HANDCASH_APP_ID / HANDCASH_APP_SECRET are not set. Auth will fail until you set them.");
}
if (!HOUSE_HANDLE || !HOUSE_AUTH_TOKEN) {
  console.warn("⚠️  HANDCASH_HOUSE_HANDLE / HANDCASH_HOUSE_AUTH_TOKEN are not set. Payments will fail until you set them.");
}
if (!DEV_HANDLE) {
  console.warn("⚠️  HANDCASH_DEV_HANDLE is not set. No dev fee will be collected -- 100% of each hit goes to the pot.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

let priceCache = { usdPerBsv: null, fetchedAt: 0 };
const PRICE_CACHE_MS = 5 * 60 * 1000;
async function getBsvUsdPrice() {
  const now = Date.now();
  if (priceCache.usdPerBsv && now - priceCache.fetchedAt < PRICE_CACHE_MS) return priceCache.usdPerBsv;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd");
    const data = await res.json();
    const price = data?.["bitcoin-cash-sv"]?.usd;
    if (price) priceCache = { usdPerBsv: price, fetchedAt: now };
  } catch (err) {
    console.warn("BSV price fetch failed:", err.message);
  }
  return priceCache.usdPerBsv;
}
app.get("/api/price", async (req, res) => {
  res.json({ usdPerBsv: await getBsvUsdPrice() });
});

const sessions = new Map();

app.get("/auth/handcash/login", (req, res) => {
  const state = req.query.room ? `room:${req.query.room}` : "";
  const url = handcash.getAuthUrl(state);
  res.redirect(url);
});

app.get("/auth/handcash/callback", async (req, res) => {
  const { authToken, state } = req.query;
  if (!authToken) return res.redirect("/?auth_error=1");
  console.log("=== HandCash authToken (copy this for HANDCASH_HOUSE_AUTH_TOKEN) ===", authToken);
  try {
    const profile = await handcash.getProfile(authToken);
    console.log("=== HandCash profile response ===", JSON.stringify(profile));

    const handle =
      profile.handle ||
      profile.publicProfile?.handle ||
      (profile.paymail ? profile.paymail.split("@")[0] : null);
    const displayName = profile.displayName || profile.publicProfile?.displayName;

    if (!handle) {
      console.error("Could not extract a handle from HandCash profile response:", JSON.stringify(profile));
      return res.redirect("/?auth_error=1");
    }

    const sessionId = randomUUID();
    sessions.set(sessionId, {
      authToken,
      handle,
      name: displayName || handle,
    });
    const room = state && state.startsWith("room:") ? state.slice(5) : "";
    res.redirect(`/?session=${sessionId}${room ? `&room=${room}` : ""}`);
  } catch (err) {
    console.error("HandCash callback error:", err.message);
    res.redirect("/?auth_error=1");
  }
});

app.get("/api/balance", async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) return res.status(401).json({ error: "Session expired." });
  try {
    const sats = await handcash.getSpendableBalanceSats(session.authToken);
    res.json({ sats });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const SATS_GRANULARITY = 1000;
function roundToGranularity(sats) {
  return Math.max(SATS_GRANULARITY, Math.round(sats / SATS_GRANULARITY) * SATS_GRANULARITY);
}
function roundDevCut(potAtEnd, devFeePercent) {
  if (potAtEnd < SATS_GRANULARITY * 2) return 0;
  const raw = potAtEnd * (devFeePercent / 100);
  const cut = Math.ceil(raw / SATS_GRANULARITY) * SATS_GRANULARITY;
  const maxCut = potAtEnd - SATS_GRANULARITY;
  return Math.min(cut, maxCut);
}
const CHALLENGE_FEE_SATS = roundToGranularity(parseInt(process.env.CHALLENGE_FEE_SATS || String(SATS_GRANULARITY), 10));

function clampStake(sats) {
  const rounded = roundToGranularity(Number.isFinite(sats) ? sats : STAKE_LEVELS[0].sats);
  return Math.min(Math.max(rounded, STAKE_LEVELS[0].sats), STAKE_LEVELS[STAKE_LEVELS.length - 1].sats);
}

app.post("/api/rooms", (req, res) => {
  const hitFeeSats = clampStake(parseInt(req.body?.hitFeeSats, 10));
  const outOfFundsMode = normalizeOutOfFundsMode(req.body?.outOfFundsMode);
  const level = nearestStakeLevel(hitFeeSats);
  const room = createRoom(hitFeeSats, outOfFundsMode);
  res.json({ code: room.code, hitFeeSats: room.hitFeeSats, level: level.level, label: level.label, feePercent: level.feePercent, outOfFundsMode });
});

app.get("/api/room-info/:code", (req, res) => {
  const room = getRoom(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: "That room code doesn't exist." });
  const level = nearestStakeLevel(room.hitFeeSats);
  res.json({
    code: room.code,
    hitFeeSats: room.hitFeeSats,
    level: level.level,
    label: level.label,
    feePercent: level.feePercent,
    outOfFundsMode: room.outOfFundsMode,
    full: room.isFull(),
  });
});

app.post("/api/challenge", async (req, res) => {
  const { sessionId, toHandle: rawHandle } = req.body || {};
  const hitFeeSats = clampStake(parseInt(req.body?.hitFeeSats, 10));
  const outOfFundsMode = normalizeOutOfFundsMode(req.body?.outOfFundsMode);
  const level = nearestStakeLevel(hitFeeSats);

  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: "Your HandCash session expired. Please reconnect." });

  const toHandle = (rawHandle || "").replace(/^\$/, "").trim();
  if (!toHandle) return res.status(400).json({ error: "Enter the handle you want to challenge." });
  if (toHandle.toLowerCase() === session.handle.toLowerCase()) {
    return res.status(400).json({ error: "You can't challenge yourself." });
  }

  const room = createRoom(hitFeeSats, outOfFundsMode);
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const joinUrl = `${baseUrl.replace(/\/$/, "")}/${room.code}`;
  const shortForm = joinUrl.replace(/^https?:\/\//, "");
  const description = shortForm.length <= 25 ? shortForm : `SatoshiPong ${room.code}`;

  try {
    await handcash.paySats({
      fromAuthToken: session.authToken,
      toHandle,
      amountSats: CHALLENGE_FEE_SATS,
      description,
    });
    res.json({ code: room.code, hitFeeSats: room.hitFeeSats, level: level.level, label: level.label, feePercent: level.feePercent, outOfFundsMode, joinUrl });
  } catch (err) {
    deleteRoom(room.code);
    console.error(`Challenge to $${toHandle} failed:`, err.message);
    res.status(400).json({ error: `Couldn't reach $${toHandle}: ${err.message}` });
  }
});

app.get("/api/leaderboard", (req, res) => {
  res.json(getLeaderboard());
});

const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/i;
app.get("/:code", (req, res, next) => {
  const code = req.params.code.toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return next();
  res.redirect(`/?room=${code}`);
});const activeLoops = new Map();

function startLoop(room) {
  if (activeLoops.has(room.code)) return;
  const interval = setInterval(() => tickRoom(room), TICK_MS);
  activeLoops.set(room.code, interval);
}

function stopLoop(roomCode) {
  const interval = activeLoops.get(roomCode);
  if (interval) clearInterval(interval);
  activeLoops.delete(roomCode);
}

function tickRoom(room) {
  const event = room.step();
  if (event?.type === "hit") handleHit(room, event.slot);
  if (event?.type === "miss") handleMiss(room, event.slot);
  if (event?.type === "powerup_collect") {
    io.to(room.code).emit("powerup_collected", { slot: event.beneficiary, effectType: event.effectType });
  }
  for (const slot of room.drainPendingExtraHits()) {
    handleHit(room, slot);
  }
  io.to(room.code).emit("state", room.publicState());
}

async function handleHit(room, slot) {
  const player = room.playerBySlot(slot);
  if (!player) return;

  const hitFee = room.hitFeeSats;

  try {
    const tx = await handcash.paySats({
      fromAuthToken: player.authToken,
      toHandle: HOUSE_HANDLE,
      amountSats: hitFee,
      description: `Pong hit ${room.rally + 1}`,
    });
    room.pot += hitFee;
    room.rally += 1;
    room.ledger.push({
      txid: tx.transactionId,
      from: player.name,
      amountSats: hitFee,
      rally: room.rally,
    });
  } catch (err) {
    console.warn(`Payment failed for ${player.name} in room ${room.code}:`, err.message);
    if (room.outOfFundsMode === "draw") {
      io.to(room.code).emit("payment_failed", { slot, message: err.message });
      handleDraw(room);
    } else if (room.outOfFundsMode === "pause") {
      room.pauseFor(slot);
      io.to(room.code).emit("payment_paused", { slot, message: err.message, hitFeeSats: room.hitFeeSats });
      io.to(room.code).emit("state", room.publicState());
    } else {
      io.to(room.code).emit("payment_failed", { slot, message: err.message });
      handleMiss(room, slot);
    }
  }
}

async function chargeActivatedPowerUp(room, activatorSlot, result) {
  const player = room.playerBySlot(activatorSlot);
  if (!player) return;

  const fee = room.hitFeeSats;
  try {
    const tx = await handcash.paySats({
      fromAuthToken: player.authToken,
      toHandle: HOUSE_HANDLE,
      amountSats: fee,
      description: `Pong power-up: ${result.type}`,
    });
    room.pot += fee;
    room.ledger.push({
      txid: tx.transactionId,
      from: player.name,
      amountSats: fee,
      rally: room.rally,
    });
    io.to(room.code).emit("powerup_triggered", { effectType: result.type, activatedBy: activatorSlot, target: result.target, ballCount: result.ballCount });
    io.to(room.code).emit("state", room.publicState());
  } catch (err) {
    console.warn(`Power-up activation payment failed for ${player.name} in room ${room.code}:`, err.message);
    if (room.outOfFundsMode === "draw") {
      io.to(room.code).emit("payment_failed", { slot: activatorSlot, message: err.message });
      handleDraw(room);
    } else if (room.outOfFundsMode === "pause") {
      room.pauseFor(activatorSlot);
      io.to(room.code).emit("payment_paused", { slot: activatorSlot, message: err.message, hitFeeSats: fee });
      io.to(room.code).emit("state", room.publicState());
    } else {
      io.to(room.code).emit("payment_failed", { slot: activatorSlot, message: err.message });
      handleMiss(room, activatorSlot);
    }
  }
}

async function handleDraw(room) {
  room.started = false;
  const p1 = room.playerBySlot("p1");
  const p2 = room.playerBySlot("p2");
  if (!p1 || !p2) return;

  const potAtEnd = room.pot;
  const feePercent = nearestStakeLevel(room.hitFeeSats).feePercent;
  let devCut = DEV_HANDLE ? roundDevCut(potAtEnd, feePercent) : 0;
  let remaining = potAtEnd - devCut;
  if ((remaining / SATS_GRANULARITY) % 2 !== 0) {
    devCut += SATS_GRANULARITY;
    remaining -= SATS_GRANULARITY;
  }
  const splitAmount = remaining / 2;

  let payoutTx = null;
  if (potAtEnd > 0) {
    try {
      const receivers = [
        { destination: p1.handle, amountSats: splitAmount },
        { destination: p2.handle, amountSats: splitAmount },
      ];
      if (devCut > 0) receivers.push({ destination: DEV_HANDLE, amountSats: devCut });
      payoutTx = await handcash.paySplit({
        fromAuthToken: HOUSE_AUTH_TOKEN,
        receivers,
        description: `Pong draw split`,
      });
    } catch (err) {
      console.error(`Draw payout failed in room ${room.code}:`, err.message);
      io.to(room.code).emit("payout_failed", { message: err.message });
    }
  }

  io.to(room.code).emit("game_over", {
    draw: true,
    rally: room.rally,
    potSats: potAtEnd,
    splitAmount,
    devCut,
    payoutTxid: payoutTx ? payoutTx.transactionId : null,
    payoutFailed: potAtEnd > 0 && !payoutTx,
    leaderboard: getLeaderboard(),
  });

  room.pot = 0;
  room.rally = 0;
  room.ledger = [];
  room.resetAfterPoint();
}

async function handleMiss(room, missedSlot) {
  if (!room.started && room.rally === 0 && room.pot === 0) return;
  room.started = false;
  const winner = room.playerBySlot(missedSlot === "p1" ? "p2" : "p1");
  const loser = room.playerBySlot(missedSlot);
  if (!winner) return;

  let payoutTx = null;
  const potAtEnd = room.pot;
  const feePercent = nearestStakeLevel(room.hitFeeSats).feePercent;
  const devCut = DEV_HANDLE ? roundDevCut(potAtEnd, feePercent) : 0;
  const winnerAmount = potAtEnd - devCut;

  if (potAtEnd > 0) {
    try {
      const receivers = [{ destination: winner.handle, amountSats: winnerAmount }];
      if (devCut > 0) receivers.push({ destination: DEV_HANDLE, amountSats: devCut });
      payoutTx = await handcash.paySplit({
        fromAuthToken: HOUSE_AUTH_TOKEN,
        receivers,
        description: `Pong payout`,
      });
    } catch (err) {
      console.error(`Payout failed in room ${room.code}:`, err.message);
      io.to(room.code).emit("payout_failed", { message: err.message });
    }
  }

  const entry = {
    winner: winner.name,
    rally: room.rally,
    potSats: potAtEnd,
    date: new Date().toISOString(),
  };
  const board = addLeaderboardEntry(entry);

  io.to(room.code).emit("game_over", {
    winner: winner.name,
    rally: room.rally,
    potSats: potAtEnd,
    winnerAmount,
    devCut,
    payoutTxid: payoutTx ? payoutTx.transactionId : null,
    payoutFailed: potAtEnd > 0 && !payoutTx,
    leaderboard: board,
  });

  room.pot = 0;
  room.rally = 0;
  room.ledger = [];
  room.resetAfterPoint();
}

const MIN_AFFORDABLE_HITS = 20;

io.on("connection", (socket) => {
  socket.on("join_room", async ({ sessionId, roomCode }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit("join_error", { message: "Your HandCash session expired. Please reconnect your wallet." });
      return;
    }
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("join_error", { message: "That room code doesn't exist." });
      return;
    }

    const minBalance = room.hitFeeSats * MIN_AFFORDABLE_HITS;
    try {
      const balance = await handcash.getSpendableBalanceSats(session.authToken);
      if (balance < minBalance) {
        socket.emit("join_error", {
          message: `You need at least ${minBalance.toLocaleString()} sats spendable to play at ${room.hitFeeSats.toLocaleString()} sats/hit (you have ${balance.toLocaleString()}). This is your HandCash spending limit for this app, not necessarily your whole balance -- you can raise it in HandCash's settings.`,
        });
        return;
      }
    } catch (err) {
      console.warn(`Balance check failed for ${session.handle}:`, err.message);
    }

    const slot = room.addPlayer(socket.id, session);
    if (!slot) {
      socket.emit("join_error", { message: "That room is already full." });
      return;
    }
    socket.data.roomCode = roomCode;
    socket.join(roomCode);
    socket.emit("joined", { slot, roomCode, name: session.name, handle: session.handle });
    io.to(roomCode).emit("state", room.publicState());
    if (room.isFull()) startLoop(room);
  });

  socket.on("input", ({ up, down }) => {
    const roomCode = socket.data.roomCode;
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    room.input[player.slot] = { up: !!up, down: !!down };
  });

  socket.on("serve", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (player && room.isFull() && !room.started && !room.paused && room.bothReadyForRematch()) room.serve(player.slot);
  });

  socket.on("activate_powerup", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const result = room.activatePowerUp(player.slot);
    if (result) chargeActivatedPowerUp(room, player.slot, result);
  });

  socket.on("resume_after_topup", async () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.paused) return;
    const player = room.players[socket.id];
    if (!player || player.slot !== room.pausedSlot) return;

    const hitFee = room.hitFeeSats;
    try {
      const tx = await handcash.paySats({
        fromAuthToken: player.authToken,
        toHandle: HOUSE_HANDLE,
        amountSats: hitFee,
        description: `Pong hit ${room.rally + 1}`,
      });
      room.pot += hitFee;
      room.rally += 1;
      room.ledger.push({
        txid: tx.transactionId,
        from: player.name,
        amountSats: hitFee,
        rally: room.rally,
      });
      room.resumeFromPause();
      io.to(room.code).emit("resumed");
      io.to(room.code).emit("state", room.publicState());
    } catch (err) {
      console.warn(`Retry after top-up still failed for ${player.name} in room ${room.code}:`, err.message);
      io.to(room.code).emit("payment_paused", { slot: player.slot, message: err.message, hitFeeSats: room.hitFeeSats });
    }
  });

  socket.on("cancel_paused_game", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.paused) return;
    const player = room.players[socket.id];
    if (!player) return;
    const stuckSlot = room.pausedSlot || player.slot;
    room.resumeFromPause();
    handleMiss(room, stuckSlot);
  });

  socket.on("ready_rematch", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    room.setReadyForRematch(player.slot);
    io.to(room.code).emit("state", room.publicState());
    if (room.bothReadyForRematch()) {
      io.to(room.code).emit("rematch_ready");
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const room = getRoom(roomCode);
    if (!room) return;
    room.removePlayer(socket.id);
    io.to(roomCode).emit("opponent_left");
    stopLoop(roomCode);
    deleteRoom(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Satoshi Pong (live) running on port ${PORT}`);
});
