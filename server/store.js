const fs = require("fs");
const path = require("path");

const LEADERBOARD_PATH = path.join(__dirname, "leaderboard.json");

function loadLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveLeaderboard(list) {
  try {
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(list, null, 2));
  } catch (err) {
    // On some free hosts the filesystem is read-only or ephemeral --
    // leaderboard just won't persist across restarts there. Swap this
    // module for a real database (Postgres, Redis, etc.) for production.
    console.warn("Could not persist leaderboard:", err.message);
  }
}

let leaderboard = loadLeaderboard();

function addLeaderboardEntry(entry) {
  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.rally - a.rally);
  leaderboard = leaderboard.slice(0, 20);
  saveLeaderboard(leaderboard);
  return leaderboard;
}

function getLeaderboard() {
  return leaderboard;
}

module.exports = { addLeaderboardEntry, getLeaderboard };
