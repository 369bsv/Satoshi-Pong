require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const handcash = require("./handcash");
const { createRoom, getRoom, deleteRoom, W, H } = require("./rooms");
const { addLeaderboardEntry, getLeaderboard } = require("./store");

const HIT_FEE_SATS = parseInt(process.env.HIT_FEE_SATS || "10", 10);
const TICK_MS = 50; // 20Hz server tick

const HOUSE_HANDLE = process.env.HANDCASH_HOUSE_HANDLE;
const HOUSE_AUTH_TOKEN = process.env.HANDCASH_HOUSE_AUTH_TOKEN;

if (!process.env.HANDCASH_APP_ID || !process.env.HANDCASH_APP_SECRET) {
  console.warn("⚠️  HANDCASH_APP_ID / HANDCASH_APP_SECRET are not set. Auth will fail until you set them.");
}
if (!HOUSE_HANDLE || !HOUSE_AUTH_TOKEN) {
  console.warn("⚠️  HANDCASH_HOUSE_HANDLE / HANDCASH_HOUSE_AUTH_TOKEN are not set. Payments will fail until you set them.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// ---------- HandCash OAuth ----------
// In-memory session store: sessionId -> { authToken, handle, name }
// Fine for a prototype; use a real store (Redis, DB) if you scale past one server.
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
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      authToken,
      handle: profile.handle,
      name: profile.displayName || profile.handle,
    });
    const room = state && state.startsWith("room:") ? state.slice(5) : "";
    res.redirect(`/?session=${sessionId}${room ? `&room=${room}` : ""}`);
  } catch (err) {
    console.error("HandCash callback error:", err.message);
    res.redirect("/?auth_error=1");
  }
});

// ---------- Rooms ----------
app.post("/api/rooms", (req, res) => {
  const room = createRoom();
  res.json({ code: room.code });
});

app.get("/api/leaderboard", (req, res) => {
  res.json(getLeaderboard());
});

// ---------- Game loop ----------
const activeLoops = new Map(); // roomCode -> interval handle

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

  try {
    const tx = await handcash.paySats({
      fromAuthToken: player.authToken,
      toHandle: HOUSE_HANDLE,
      amountSats: HIT_FEE_SATS,
      description: `Satoshi Pong hit #${room.rally + 1}`,
    });
    room.pot += HIT_FEE_SATS;
    room.rally += 1;
    room.ledger.push({
      txid: tx.transactionId,
      from: player.name,
      amountSats: HIT_FEE_SATS,
      rally: room.rally,
    });
  } catch (err) {
    // Player couldn't actually pay for the hit they just made (spending
    // limit, insufficient balance, network error) -- they forfeit the point.
    console.warn(`Payment failed for ${player.name} in room ${room.code}:`, err.message);
    io.to(room.code).emit("payment_failed", { slot, message: err.message });
    handleMiss(room, slot);
  }
}

async function handleMiss(room, missedSlot) {
  if (!room.started && room.rally === 0 && room.pot === 0) return; // nothing in progress
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
        description: `Satoshi Pong payout — beat ${loser ? loser.name : "opponent"}`,
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

// ---------- Socket.IO ----------
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
