const { randomUUID } = require("crypto");

const W = 900, H = 480;
const PADDLE_W = 12, PADDLE_H = 90, PADDLE_SPEED = 7, BALL_R = 8;
const POWERUP_R = 16;
const POWERUP_SPAWN_EVERY_HITS = 6;
const NEGATIVE_TYPES = ["shrink", "reverse", "speedup"];
const POSITIVE_TYPES = ["grow", "multiball", "slowball"];
const POWERUP_TYPES = [...NEGATIVE_TYPES, ...POSITIVE_TYPES];
const EFFECT_DURATION_MS = 6000;
const SHRUNK_PADDLE_H = 50;
const GROWN_PADDLE_H = 150;
const EXTRA_BALL_COUNT = 2;

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
    this.extraBalls = [];
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
    this.heldPowerUp = { p1: null, p2: null };
    this.effects = { p1: null, p2: null };
    this.paddleHeights = { p1: PADDLE_H, p2: PADDLE_H };
    this.ballSpeedEffect = null;
    this.multiballExpiresAt = null;
    this.pendingExtraHits = [];
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
    this.extraBalls = [];
    this.readyForRematch = { p1: false, p2: false };
    this.armedServe = null;
    this.powerUp = null;
    this.hitsSincePowerUp = 0;
    this.lastHitBy = null;
    this.heldPowerUp = { p1: null, p2: null };
    this.effects = { p1: null, p2: null };
    this.paddleHeights = { p1: PADDLE_H, p2: PADDLE_H };
    this.ballSpeedEffect = null;
    this.multiballExpiresAt = null;
    this.pendingExtraHits = [];
  }

  activatePowerUp(slot) {
    const held = this.heldPowerUp[slot];
    if (!held) return null;
    this.heldPowerUp[slot] = null;
    const opponent = slot === "p1" ? "p2" : "p1";
    const expiresAt = Date.now() + EFFECT_DURATION_MS;

    if (held.type === "shrink" || held.type === "reverse") {
      this.effects[opponent] = { type: held.type, expiresAt };
      return { type: held.type, activatedBy: slot, target: opponent, expiresAt };
    }
    if (held.type === "speedup") {
      this.ballSpeedEffect = { type: "fast", expiresAt };
      return { type: held.type, activatedBy: slot, target: opponent, expiresAt };
    }
    if (held.type === "grow") {
      this.effects[slot] = { type: "grow", expiresAt };
      return { type: held.type, activatedBy: slot, target: slot, expiresAt };
    }
    if (held.type === "slowball") {
      this.ballSpeedEffect = { type: "slow", expiresAt };
      return { type: held.type, activatedBy: slot, target: slot, expiresAt };
    }
    if (held.type === "multiball") {
      const source = this.ball;
      for (let i = 0; i < EXTRA_BALL_COUNT; i++) {
        const angleJitter = (Math.random() - 0.5) * 3;
        this.extraBalls.push({
          x: source.x, y: source.y,
          vx: (source.vx || (Math.random() > 0.5 ? 5 : -5)),
          vy: (source.vy || 0) + angleJitter,
        });
      }
      this.multiballExpiresAt = expiresAt;
      return { type: held.type, activatedBy: slot, target: slot, expiresAt };
    }
    return null;
  }

  step() {
    if (this.paused) return null;

    const now = Date.now();
    for (const slot of ["p1", "p2"]) {
      if (this.effects[slot] && this.effects[slot].expiresAt <= now) this.effects[slot] = null;
    }
    if (this.ballSpeedEffect && this.ballSpeedEffect.expiresAt <= now) this.ballSpeedEffect = null;
    if (this.multiballExpiresAt && now > this.multiballExpiresAt) {
      this.extraBalls = [];
      this.multiballExpiresAt = null;
    }

    this.paddleHeights.p1 = this.effects.p1?.type === "shrink" ? SHRUNK_PADDLE_H
      : this.effects.p1?.type === "grow" ? GROWN_PADDLE_H : PADDLE_H;
    this.paddleHeights.p2 = this.effects.p2?.type === "shrink" ? SHRUNK_PADDLE_H
      : this.effects.p2?.type === "grow" ? GROWN_PADDLE_H : PADDLE_H;

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

    const speedMul = this.ballSpeedEffect?.type === "fast" ? 1.6 : this.ballSpeedEffect?.type === "slow" ? 0.55 : 1;

    for (let i = this.extraBalls.length - 1; i >= 0; i--) {
      const eb = this.extraBalls[i];
      eb.x += eb.vx * speedMul;
      eb.y += eb.vy * speedMul;
      if (eb.y - BALL_R < 0 || eb.y + BALL_R > H) {
        eb.vy *= -1;
        eb.y = clamp(eb.y, BALL_R, H - BALL_R);
      }
      let consumed = false;
      if (eb.x - BALL_R < PADDLE_W + 10 && eb.y > this.paddles.p1 && eb.y < this.paddles.p1 + this.paddleHeights.p1 && eb.vx < 0) {
        eb.vx *= -1.05;
        eb.x += 14;
        this.pendingExtraHits.push("p1");
        consumed = true;
      } else if (eb.x + BALL_R > W - PADDLE_W - 10 && eb.y > this.paddles.p2 && eb.y < this.paddles.p2 + this.paddleHeights.p2 && eb.vx > 0) {
        eb.vx *= -1.05;
        eb.x -= 14;
        this.pendingExtraHits.push("p2");
        consumed = true;
      }
      if (!consumed && (eb.x - BALL_R < 0 || eb.x + BALL_R > W)) {
        this.extraBalls.splice(i, 1);
      }
    }

    if (this.armedServe) {
      this.ball = ballParkedAt(this.armedServe, this.paddles);
      return null;
    }

    if (!this.started) return null;

    const b = this.ball;
    b.x += b.vx * speedMul;
    b.y += b.vy * speedMul;

    if (b.y - BALL_R < 0 || b.y + BALL_R > H) {
      b.vy *= -1;
      b.y = clamp(b.y, BALL_R, H - BALL_R);
    }

    if (this.powerUp) {
      const dx = b.x - this.powerUp.x, dy = b.y - this.powerUp.y;
      if (Math.sqrt(dx * dx + dy * dy) < BALL_R + POWERUP_R) {
        const effectType = this.powerUp.type;
        const beneficiary = this.lastHitBy;
        this.powerUp = null;
        if (beneficiary) this.heldPowerUp[beneficiary] = { type: effectType };
        return { type: "powerup_collect", effectType, beneficiary };
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

  drainPendingExtraHits() {
    const out = this.pendingExtraHits;
    this.pendingExtraHits = [];
    return out;
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
      extraBalls: this.extraBalls,
      paddles: this.paddles,
      paddleHeights: this.paddleHeights,
      powerUp: this.powerUp,
      heldPowerUp: this.heldPowerUp,
      effects: this.effects,
      ballSpeedEffect: this.ballSpeedEffect,
      multiballExpiresAt: this.multiballExpiresAt,
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

module.exports = { createRoom, getRoom, deleteRoom, rooms, W, H, NEGATIVE_TYPES, POSITIVE_TYPES };
