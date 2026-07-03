require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const handcash = require("./handcash");
const { createRoom, getRoom, deleteRoom, W, H } = require("./rooms");
const { addLeaderboardEntry, getLeaderboard } = require("./store");

const TICK_MS = 50;

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
  try {
    const profile = await handcash.getProfile(authToken);
    // TEMPORARY DEBUG LINE -- remove once handle/name extraction is confirmed correct.
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

const MIN_HIT_FEE_SATS = 1;
const MAX_HIT_FEE_SATS = 1000000;
const CHALLENGE_FEE_SATS = parseInt(process.env.CHALLENGE_FEE_SATS || "1", 10);

app.post("/api/rooms", (req, res) => {
  let hitFeeSats = parseInt(req.body?.hitFeeSats, 10);
  if (!Number.isFinite(hitFeeSats) || hitFeeSats < MIN_HIT_FEE_SATS) hitFeeSats = MIN_HIT_FEE_SATS;
  if (hitFeeSats > MAX_HIT_FEE_SATS) hitFeeSats = MAX_HIT_FEE_SATS;
  const room = createRoom(hitFeeSats);
  res.json({ code: room.code, hitFeeSats: room.hitFeeSats });
});

app.post("/api/challenge", async (req, res) => {
  const { sessionId, toHandle: rawHandle } = req.body || {};
  let hitFeeSats = parseInt(req.body?.hitFeeSats, 10);
  if (!Number.isFinite(hitFeeSats) || hitFeeSats < MIN_HIT_FEE_SATS) hitFeeSats = MIN_HIT_FEE_SATS;
  if (hitFeeSats > MAX_HIT_FEE_SATS) hitFeeSats = MAX_HIT_FEE_SATS;

  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: "Your HandCash session expired. Please reconnect." });

  const toHandle = (rawHandle || "").replace(/^\$/, "").trim();
  if (!toHandle) return res.status(400).json({ error: "Enter the handle you want to challenge." });
  if (toHandle.toLowerCase() === session.handle.toLowerCase()) {
    return res.status(400).json({ error: "You can't challenge yourself." });
  }

  const room = createRoom(hitFeeSats);
  const joinUrl = `${req.protocol}://${req.get("host")}/?room=${room.code}`;

  try {
    await handcash.paySats({
      fromAuthToken: session.authToken,
      toHandle,
      amountSats: CHALLENGE_FEE_SATS,
      description:`SatoshiPong ${room.code}`,
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
  const devCut = DEV_HANDLE ? Math.floor(hitFee * (DEV_FEE_PERCENT / 100)) : 0;
  const potCut = hitFee - devCut;

  const receivers = [{ destination: HOUSE_HANDLE, amountSats: potCut }];
  if (devCut > 0) receivers.push({ destination: DEV_HANDLE, amountSats: devCut });

  try {
    const tx = await handcash.paySplit({
      fromAuthToken: player.authToken,
      receivers,
      description:`Pong hit ${room.rally + 1}`,
    });
    room.pot += potCut;
    room.rally += 1;
    room.ledger.push({
      txid: tx.transactionId,
      from: player.name,
      amountSats: hitFee,
      potSats: potCut,
      devSats: devCut,
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
  if (potAtEnd > 0) {
    try {
      payoutTx = await handcash.paySats({
        fromAuthToken: HOUSE_AUTH_TOKEN,
        toHandle: winner.handle,
        amountSats: potAtEnd,
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
    payoutTxid: payoutTx ? payoutTx.transactionId : null,
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
    if (room && room.isFull() && !room.started) room.serve();
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
