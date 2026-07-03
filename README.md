# Satoshi Pong — Live

Worldwide 2-player Pong. Every paddle hit is a **real BSV payment** (via
HandCash) into a shared pot; miss the ball and your opponent gets the pot.
Longest-rally leaderboard included.

This is the "real money, real opponents" version. If you just want to try
the game mechanics with no wallet and no setup, use the single-file
`satoshi-pong.html` from earlier instead.

## How the money works

1. Both players connect their own HandCash wallet (OAuth — they log in on
   HandCash's site, you never see their password or private keys).
2. Every paddle hit fires a real HandCash payment of `HIT_FEE_SATS`
   (default 10 sats) from the hitting player to your app's **house account**.
3. The house account holds the pot until someone misses, then pays the
   entire pot to the winner in one more real payment.
4. If a player's payment for a hit fails (spending limit reached,
   insufficient balance, network hiccup), they immediately forfeit — the
   game can't let a hit "count" without the money actually moving.

**Physics run on the server**, not in either player's browser — with real
money on the line, neither player's client should be the referee. Both
browsers just send which direction their paddle is moving and render
whatever the server tells them is happening.

## One-time setup

### 1. Create a HandCash app

Go to [dashboard.handcash.io](https://dashboard.handcash.io), create an
app, and note your `appId` and `appSecret`. Set the app's **Authorization
Success URL** to:

```
https://YOUR-DEPLOYED-URL/auth/handcash/callback
```

(You'll fill in the real URL once you've deployed — see below. You can
update this field later.)

### 2. Create the house account

The house account is just a normal HandCash account that your app
controls — it's what holds the pot mid-game. Create one (e.g.
`$satoshipongapp`), then authorize it against your own app the same way a
player would:

1. Temporarily visit `https://YOUR-DEPLOYED-URL/auth/handcash/login`
   while logged into the house account's HandCash.
2. After approving, you'll land back on `/?session=...&auth_error=...` —
   grab the `authToken` from your server logs (it's what the callback
   route receives before it's exchanged for a session).

Simplest way to grab it: temporarily add `console.log(authToken)` in
`server/index.js`'s `/auth/handcash/callback` route, do the login once,
copy the token from your logs, then remove the log line.

### 3. Set environment variables

Copy `.env.example` to `.env` and fill in:

```
HANDCASH_APP_ID=...
HANDCASH_APP_SECRET=...
HANDCASH_HOUSE_HANDLE=satoshipongapp     # no $ prefix
HANDCASH_HOUSE_AUTH_TOKEN=...            # from step 2
HIT_FEE_SATS=10
```

## Deploy (Render — free option)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New → Web Service** → connect
   your repo.
3. Environment: **Node**. Build command: `npm install`. Start command:
   `npm start`.
4. Add the environment variables from `.env` in Render's dashboard
   (Settings → Environment).
5. Deploy. Render gives you a URL like `https://satoshi-pong.onrender.com`
   — go back to your HandCash app settings and set the Authorization
   Success URL to `https://satoshi-pong.onrender.com/auth/handcash/callback`.

Free tier note: Render's free web services spin down after inactivity and
take ~30–60s to wake back up on the next visit. Fine for testing with
friends; upgrade to a paid instance if you want it always warm.

## Playing

1. Player 1 opens the deployed URL, clicks **Connect HandCash**, then
   **Create Room** — this gives them a shareable link.
2. Player 1 sends that link to Player 2, anywhere in the world.
3. Player 2 opens it, clicks **Connect HandCash**, and is dropped straight
   into the same room.
4. P1 controls: **W / S**. P2 controls: **↑ / ↓**. **Space** serves.

## Known limitations / where to harden this before real stakes

- **Sessions are in-memory** (`sessions` Map in `server/index.js`) — they
  reset on server restart, and won't work if you ever scale to more than
  one server instance without moving them to Redis or a database.
- **Leaderboard is a flat JSON file** — same caveat; fine for a prototype,
  not for concurrent production traffic, and may not persist across
  restarts on some hosts (Render's free tier included).
- **House authToken doesn't auto-refresh.** HandCash tokens can expire;
  for anything beyond casual use, add logic to detect an expired token and
  re-authenticate the house account automatically.
- **No reconnect handling.** If a player's browser refreshes mid-game,
  they lose their spot in the room (their money already paid into the pot
  stays there, but they can't reconnect to finish the game). Worth adding
  before this sees real traffic.
- **Server-authoritative physics adds latency** — the ball's position a
  player sees is always slightly behind real time by however long the
  network round-trip is. Fine for casual play; competitive players over
  long distances will feel it. Client-side prediction/interpolation would
  smooth this out, at the cost of more complexity.
