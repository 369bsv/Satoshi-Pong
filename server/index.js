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
