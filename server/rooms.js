const { randomUUID } = require("crypto");

const W = 900, H = 480;
const PADDLE_W = 12, PADDLE_H = 90, PADDLE_SPEED = 7, BALL_R = 8;
const POWERUP_R = 14;
const POWERUP_SPAWN_EVERY_HITS = 6;
const POWERUP_TYPES = ["speed", "shrink", "reverse"];
const EFFECT_DURATION_MS = 6000;
const SHRUNK_PADDLE_H = 50;

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function ballParkedAt(slot, paddles) {
  const startX = slot === "p1"
    ? PADDLE_W + 10 + BALL_R + 4
    : W - PADDLE_W - 10 - BALL_R - 4;
  const startY = paddles[slot] + PADDLE_H / 2;
  return { x: startX, y: startY, vx: 0, vy: 0 };
}

class Room {
  constructor(code, hitFeeSats, outOfFundsMode) {
    this.code = code;
    this.id = randomUUID();
    this.hitFeeSats = hitFeeSats;
    this.outOfFundsMode = outOfFundsMode || "forfeit";
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
    this.armedServe = null;
    this.paused = false;
    this.pausedSlot = null;
    this.frozenBall = null;
    this.powerUp = null;
    this.hitsSincePowerUp = 0;
    this.lastHitBy = null;
    this.effects = { p1: null, p2: null };
    this.paddleHeights = { p1: PADDLE_H, p2: PADDLE_H };
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

  pauseFor(slot) {
    this.paused = true;
    this.pausedSlot = slot;
    this.frozenBall = { vx: this.ball.vx, vy: this.ball.vy };
    this.ball.vx = 0;
    this.ball.vy = 0;
  }

  resumeFromPause() {
    if (!this.paused) return;
    if (this.frozenBall) {
      this.ball.vx = this.frozenBall.vx;
      this.ball.vy = this.frozenBall.vy;
    }
    this.paused = false;
    this.pausedSlot = null;
    this.frozenBall = null;
  }

  serve(slot) {
    if (this.started) return;
    if (this.armedServe === slot) {
      const dir = slot === "p1" ? 1 : -1;
      this.ball.vx = 5 * dir;
      this.ball.vy = Math.random() * 4 - 2;
      this.started = true;
      this.armedServe = null;
    } else if (!this.armedServe) {
      this.armedServe = slot;
      this.ball = ballParkedAt(slot, this.paddles);
    }
  }

  resetAfterPoint() {
    this.started = false;
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    this.readyForRematch = { p1: false, p2: false };
    this.armedServe = null;
    this.powerUp = null;
    this.hitsSincePowerUp = 0;
    this.lastHitBy = null;
    this.effects = { p1: null, p2: null };
    this.paddleHeights = { p1: PADDLE_H, p2: PADDLE_H };
  }

  step() {
    if (this.paused) return null;

    const now = Date.now();
    for (const slot of ["p1", "p2"]) {
      if (this.effects[slot] && this.effects[slot].expiresAt <= now) this.effects[slot] = null;
    }
    this.paddleHeights.p1 = this.effects.p1?.type === "shrink" ? SHRUNK_PADDLE_H : PADDLE_H;
    this.paddleHeights.p2 = this.effects.p2?.type === "shrink" ? SHRUNK_PADDLE_H : PADDLE_H;

    const p1Reversed = this.effects.p1?.type === "reverse";
    const p2Reversed = this.effects.p2?.type === "reverse";
    const p1Up = p1Reversed ? this.input.p1.down : this.input.p1.up;
    const p1Down = p1Reversed ? this.input.p1.up : this.input.p1.down;
    const p2Up = p2Reversed ? this.input.p2.down : this.input.p2.up;
    const p2Down = p2Reversed ? this.input.p2.up : this.input.p2.down;

    if (p1Up) this.paddles.p1 -= PADDLE_SPEED;
    if (p1Down) this.paddles.p1 += PADDLE_SPEED;
    if (p2Up) this.paddles.p2 -= PADDLE_SPEED;
    if (p2Down) this.paddles.p2 += PADDLE_SPEED;
    this.paddles.p1 = clamp(this.paddles.p1, 0, H - this.paddleHeights.p1);
    this.paddles.p2 = clamp(this.paddles.p2, 0, H - this.paddleHeights.p2);

    if (this.armedServe) {
      this.ball = ballParkedAt(this.armedServe, this.paddles);
      return null;
    }

    if (!this.started) return null;

    const b = this.ball;
    b.x += b.vx;
    b.y += b.vy;

    if (b.y - BALL_R < 0 || b.y + BALL_R > H) {
      b.vy *= -1;
      b.y = clamp(b.y, BALL_R, H - BALL_R);
    }

    if (this.powerUp) {
      const dx = b.x - this.powerUp.x, dy = b.y - this.powerUp.y;
      if (Math.sqrt(dx * dx + dy * dy) < BALL_R + POWERUP_R) {
        const effectType = this.powerUp.type;
        const beneficiary = this.lastHitBy;
        const target = beneficiary === "p1" ? "p2" : "p1";
        this.powerUp = null;
        if (effectType === "speed") {
          const maxSpeed = 16;
          b.vx = clamp(b.vx * 1.6, -maxSpeed, maxSpeed);
          b.vy = clamp(b.vy * 1.6, -maxSpeed, maxSpeed);
        } else if (beneficiary) {
          this.effects[target] = { type: effectType, expiresAt: Date.now() + EFFECT_DURATION_MS };
        }
        return { type: "powerup", effectType, beneficiary, target };
      }
    }

    if (b.x - BALL_R < PADDLE_W + 10 && b.y > this.paddles.p1 && b.y < this.paddles.p1 + this.paddleHeights.p1 && b.vx < 0) {
      return this.bounce("p1");
    }
    if (b.x + BALL_R > W - PADDLE_W - 10 && b.y > this.paddles.p2 && b.y < this.paddles.p2 + this.paddleHeights.p2 && b.vx > 0) {
      return this.bounce("p2");
    }
    if (b.x - BALL_R < 0) return { type: "miss", slot: "p1" };
    if (b.x + BALL_R > W) return { type: "miss", slot: "p2" };
    return null;
  }

  bounce(slot) {
    const b = this.ball;
    const paddleY = this.paddles[slot];
    const paddleH = this.paddleHeights[slot];
    b.vx *= -1.05;
    const relativeHit = (b.y - (paddleY + paddleH / 2)) / (paddleH / 2);
    b.vy = relativeHit * 5;
    b.x += b.vx > 0 ? 14 : -14;
    this.lastHitBy = slot;
    this.maybeSpawnPowerUp();
    return { type: "hit", slot };
  }

  maybeSpawnPowerUp() {
    if (this.powerUp) return;
    this.hitsSincePowerUp += 1;
    if (this.hitsSincePowerUp >= POWERUP_SPAWN_EVERY_HITS) {
      this.hitsSincePowerUp = 0;
      this.powerUp = {
        x: W * 0.3 + Math.random() * W * 0.4,
        y: BALL_R + POWERUP_R + Math.random() * (H - 2 * (BALL_R + POWERUP_R)),
        type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)],
      };
    }
  }

  publicState() {
    return {
      ball: this.ball,
      paddles: this.paddles,
      paddleHeights: this.paddleHeights,
      powerUp: this.powerUp,
      effects: this.effects,
      started: this.started,
      armedServe: this.armedServe,
      pot: this.pot,
      rally: this.rally,
      hitFeeSats: this.hitFeeSats,
      outOfFundsMode: this.outOfFundsMode,
      paused: this.paused,
      pausedSlot: this.pausedSlot,
      readyForRematch: this.readyForRematch,
      ledger: this.ledger.slice(-8),
      players: Object.values(this.players).map((p) => ({ slot: p.slot, name: p.name, handle: p.handle })),
    };
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

const rooms = new Map();

function createRoom(hitFeeSats, outOfFundsMode) {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = new Room(code, hitFeeSats, outOfFundsMode);
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
