const { HandCashConnect } = require("@handcash/handcash-connect");

const handCashConnect = new HandCashConnect({
  appId: process.env.HANDCASH_APP_ID,
  appSecret: process.env.HANDCASH_APP_SECRET,
});

function getAuthUrl(state) {
  return handCashConnect.getRedirectionUrl(state ? { state } : undefined);
}

function accountFor(authToken) {
  return handCashConnect.getAccountFromAuthToken(authToken);
}

async function getProfile(authToken) {
  const account = accountFor(authToken);
  const { publicProfile } = await account.profile.getCurrentProfile();
  return publicProfile;
}

async function paySplit({ fromAuthToken, receivers, description }) {
  const account = accountFor(fromAuthToken);
  const result = await account.wallet.pay({
    description,
    appAction: "SatoshiPong",
    payments: receivers.map((r) => ({
      destination: r.destination,
      currencyCode: "SAT",
      sendAmount: r.amountSats,
    })),
  });
  return result;
}

async function paySats({ fromAuthToken, toHandle, amountSats, description }) {
  return paySplit({ fromAuthToken, receivers: [{ destination: toHandle, amountSats }], description });
}

async function getSpendableBalanceSats(authToken) {
  const account = accountFor(authToken);
  const bsv = await account.wallet.getSpendableBalance("BSV");
  return Math.round(Number(bsv) * 100000000);
}

module.exports = { getAuthUrl, getProfile, paySats, paySplit, getSpendableBalanceSats };
