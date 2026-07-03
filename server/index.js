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
const DEV_FEE_PERCENT = parseFloat(process.env.DEV_FEE_PERCENT || "1");

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

const SATS_GRANULARITY = 1000;
const MIN_HIT_FEE_SATS = SATS_GRANULARITY;
function roundToGranularity(sats) {
  return Math.max(SATS_GRANULARITY, Math.round(sats / SATS_GRANULARITY) * SATS_GRANULARITY);
}
function roundDevCut(hitFeeSats, devFeePercent) {
  const raw = hitFeeSats * (devFeePercent / 100);
  return Math.round(raw / SATS_GRANULARITY) * SATS_GRANULARITY;
}
const CHALLENGE_FEE_SATS = roundToGranularity(parseInt(process.env.CHALLENGE_FEE_SATS || String(SATS_GRANULARITY), 10));
const MAX_HIT_FEE_SATS = 1000000;

app.post("/api/rooms", (req, res) => {
  let hitFeeSats = parseInt(req.body?.hitFeeSats, 10);
  if (!Number.isFinite(hitFeeSats) || hitFeeSats < MIN_HIT_FEE_SATS) hitFeeSats = MIN_HIT_FEE_SATS;
  hitFeeSats = roundToGranularity(Math.min(hitFeeSats, MAX_HIT_FEE_SATS));
  const room = createRoom(hitFeeSats);
  res.json({ code: room.code, hitFeeSats: room.hitFeeSats });
});

app.post("/api/challenge", async (req, res) => {
  const { sessionId, toHandle: rawHandle } = req.body || {};
  let hitFeeSats = parseInt(req.body?.hitFeeSats, 10);
  if (!Number.isFinite(hitFeeSats) || hitFeeSats < MIN_HIT_FEE_SATS) hitFeeSats = MIN_HIT_FEE_SATS;
  hitFeeSats = roundToGranularity(Math.min(hitFeeSats, MAX_HIT_FEE_SATS));

  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: "Your HandCash session expired. Please reconnect." });

  const toHandle = (rawHandle || "").replace(/^\$/, "").trim();
  if (!toHandle) return res.status(400).json({ error: "Enter the handle you want to challenge." });
  if (toHandle.toLowerCase() === session.handle.toLowerCase()) {
    return res.status(400).json({ error: "You can't challenge yourself." });
  }

  const room = createRoom(hitFeeSats);
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
    res.json({ code: room.code, hitFeeSats: room.hitFeeSats, joinUrl });
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
});

const activeLoops = new Map();

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
    io.to(room.code).emit("payment_failed", { slot, message: err.message });
    handleMiss(room, slot);
  }
}

async function handleMiss(room, missedSlot) {
  if (!room.started && room.rally === 0 && room.pot === 0) return;
  room.started = false;
  const winner = room.playerBySlot(missedSlot === "p1" ? "p2" : "p1");
  const loser = room.playerBySlot(missedSlot);
  if (!winner) return;

  let payoutTx = null;
  const potAtEnd = room.pot;
  const devCut = DEV_HANDLE ? roundDevCut(potAtEnd, DEV_FEE_PERCENT) : 0;
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

io.on("connection", (socket) => {
  socket.on("join_room", ({ sessionId, roomCode }) => {
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
    if (room && room.isFull() && !room.started && room.bothReadyForRematch()) room.serve();
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
    if (Object.keys(room.players).length === 0) {
      stopLoop(roomCode);
      deleteRoom(roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Satoshi Pong (live) running on port ${PORT}`);
});
