const { randomUUID } = require("crypto");

const W = 900, H = 480;
const PADDLE_W = 12, PADDLE_H = 90, PADDLE_SPEED = 7, BALL_R = 8;

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function freshBall(slot, paddles) {
  if (!slot || !paddles) {
    const dir = Math.random() > 0.5 ? 1 : -1;
    return { x: W / 2, y: H / 2, vx: 5 * dir, vy: Math.random() * 4 - 2 };
  }
  const dir = slot === "p1" ? 1 : -1;
  const startX = slot === "p1"
    ? PADDLE_W + 10 + BALL_R + 4
    : W - PADDLE_W - 10 - BALL_R - 4;
  const startY = paddles[slot] + PADDLE_H / 2;
  return { x: startX, y: startY, vx: 5 * dir, vy: Math.random() * 4 - 2 };
}

class Room {
  constructor(code, hitFeeSats) {
    this.code = code;
    this.id = randomUUID();
    this.hitFeeSats = hitFeeSats;
    this.players = {};
    this.paddles = { p1: H / 2 - PADDLE_H / 2, p2: H / 2 - PADDLE_H / 2 };
    this.input = { p1: { up: false, down: false }, p2: { up: false, down: false } };
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    this.started = false;
    this.pot = 0;
    this.rally = 0;
    this.ledger = [];
    this.paymentLock = { p1: false, p2: false };
    this.readyForRematch = { p1: true, p2: true };
  }

  addPlayer(socketId, { handle, authToken, name }) {
    const taken = Object.values(this.players).map((p) => p.slot);
    const slot = !taken.includes("p1") ? "p1" : !taken.includes("p2") ? "p2" : null;
    if (!slot) return null;
    this.players[socketId] = { slot, handle, authToken, name: name || handle };
    return slot;
  }

  removePlayer(socketId) {
    delete this.players[socketId];
  }

  isFull() {
    return Object.keys(this.players).length === 2;
  }

  playerBySlot(slot) {
    return Object.values(this.players).find((p) => p.slot === slot);
  }

  setReadyForRematch(slot) {
    this.readyForRematch[slot] = true;
  }

  bothReadyForRematch() {
    return this.readyForRematch.p1 && this.readyForRematch.p2;
  }

  serve(slot) {
    this.ball = freshBall(slot, this.paddles);
    this.started = true;
  }

  resetAfterPoint() {
    this.started = false;
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    this.readyForRematch = { p1: false, p2: false };
  }

  step() {
    if (this.input.p1.up) this.paddles.p1 -= PADDLE_SPEED;
    if (this.input.p1.down) this.paddles.p1 += PADDLE_SPEED;
    if (this.input.p2.up) this.paddles.p2 -= PADDLE_SPEED;
    if (this.input.p2.down) this.paddles.p2 += PADDLE_SPEED;
    this.paddles.p1 = clamp(this.paddles.p1, 0, H - PADDLE_H);
    this.paddles.p2 = clamp(this.paddles.p2, 0, H - PADDLE_H);

    if (!this.started) return null;

    const b = this.ball;
    b.x += b.vx;
    b.y += b.vy;

    if (b.y - BALL_R < 0 || b.y + BALL_R > H) {
      b.vy *= -1;
      b.y = clamp(b.y, BALL_R, H - BALL_R);
    }

    if (b.x - BALL_R < PADDLE_W + 10 && b.y > this.paddles.p1 && b.y < this.paddles.p1 + PADDLE_H && b.vx < 0) {
      return this.bounce("p1");
    }
    if (b.x + BALL_R > W - PADDLE_W - 10 && b.y > this.paddles.p2 && b.y < this.paddles.p2 + PADDLE_H && b.vx > 0) {
      return this.bounce("p2");
    }
    if (b.x - BALL_R < 0) return { type: "miss", slot: "p1" };
    if (b.x + BALL_R > W) return { type: "miss", slot: "p2" };
    return null;
  }

  bounce(slot) {
    const b = this.ball;
    const paddleY = this.paddles[slot];
    b.vx *= -1.05;
    const relativeHit = (b.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2);
    b.vy = relativeHit * 5;
    b.x += b.vx > 0 ? 14 : -14;
    return { type: "hit", slot };
  }

  publicState() {
    return {
      ball: this.ball,
      paddles: this.paddles,
      started: this.started,
      pot: this.pot,
      rally: this.rally,
      hitFeeSats: this.hitFeeSats,
      readyForRematch: this.readyForRematch,
      ledger: this.ledger.slice(-8),
      players: Object.values(this.players).map((p) => ({ slot: p.slot, name: p.name, handle: p.handle })),
    };
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

const rooms = new Map();

function createRoom(hitFeeSats) {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = new Room(code, hitFeeSats);
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function deleteRoom(code) {
  rooms.delete(code);
}

module.exports = { createRoom, getRoom, deleteRoom, rooms, W, H };
