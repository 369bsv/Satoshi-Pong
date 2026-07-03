const { getInstance, Connect } = require("@handcash/sdk");

const sdk = getInstance({
  appId: process.env.HANDCASH_APP_ID,
  appSecret: process.env.HANDCASH_APP_SECRET,
});

/**
 * Redirect URL that sends a player to HandCash to authorize this app.
 * `state` round-trips back to your callback so you can tell which
 * socket/room initiated the login.
 */
function getAuthUrl(state) {
  return sdk.getRedirectionUrl({ state });
}

function clientFor(authToken) {
  return sdk.getAccountClient(authToken);
}

async function getProfile(authToken) {
  const client = clientFor(authToken);
  const result = await Connect.getCurrentUserProfile({ client });
  if (result.error) throw new Error(result.error.message || "HandCash profile lookup failed");
  return result.data; // { handle, displayName, avatarUrl, ... }
}

/**
 * Pay `amountSats` from the account behind `fromAuthToken` to `toHandle`.
 * Real BSV, real transaction, via HandCash's rails.
 */
async function paySats({ fromAuthToken, toHandle, amountSats, description }) {
  const client = clientFor(fromAuthToken);
  const amountBSV = amountSats / 100000000;
  const result = await Connect.pay({
    client,
    body: {
      instrumentCurrencyCode: "BSV",
      denominationCurrencyCode: "BTC",
      receivers: [{ sendAmount: amountBSV, destination: toHandle }],
      description,
    },
  });
  if (result.error) throw new Error(result.error.message || "HandCash payment failed");
  return result.data; // includes transactionId
}

module.exports = { getAuthUrl, clientFor, getProfile, paySats };
