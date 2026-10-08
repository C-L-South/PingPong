const fs = require("fs");
const { handleAdmin, getAdmin } = require("../lib/admin");
const path = require("path");

const K_FACTOR = 32;
const KV_KEY = "carroll_pingpong_db";

const DATA_DIR = path.join("/tmp", "data");
const LOCAL_DB_FILE = path.join(__dirname, "..", "data", "db.json");
const TMP_DB_FILE = path.join(DATA_DIR, "db.json");

const INITIAL_DB = {
  version: 1,
  accounts: [],
  players: [],
  matches: []
};

// Elo Math
function expectedProbability(playerElo, opponentElo) {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

function calculateEloGain(winnerElo, loserElo) {
  const prob = expectedProbability(winnerElo, loserElo);
  const change = Math.round(K_FACTOR * (1 - prob));
  return Math.max(1, change);
}

// Storage Helpers (Supports Vercel KV / Upstash Redis, or local/tmp filesystem fallback)
async function getDatabase() {
  // 1. Check Vercel KV / Upstash Redis
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/${KV_KEY}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error("KV storage unavailable");
      if (data && data.result) {
        const raw = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
        return { db: JSON.parse(raw), original: raw };
      }
      return { db: JSON.parse(JSON.stringify(INITIAL_DB)), original: "" };
    } catch (err) {
      throw err;
    }
  }

  // 2. Fallback to filesystem
  if (fs.existsSync(LOCAL_DB_FILE)) {
    try {
      return { db: JSON.parse(fs.readFileSync(LOCAL_DB_FILE, "utf8")), original: "" };
    } catch (e) { throw e; }
  }
  if (fs.existsSync(TMP_DB_FILE)) {
    try {
      return { db: JSON.parse(fs.readFileSync(TMP_DB_FILE, "utf8")), original: "" };
    } catch (e) { throw e; }
  }

  return { db: JSON.parse(JSON.stringify(INITIAL_DB)), original: "" };
}

async function saveDatabase(db, original) {
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!(kvUrl && kvToken)) throw new Error("Persistent KV storage is required for serverless writes.");
  // Compare the state read by this request before replacing it. Concurrent changes
  // cause a retryable conflict instead of losing another player's update.
  const script = `local current = redis.call('GET', KEYS[1]); if current ~= ARGV[1] and not (not current and ARGV[1] == '') then return 0 end; redis.call('SET', KEYS[1], ARGV[2]); return 1`;
  const response = await fetch(kvUrl, {
    method: "POST", headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(["EVAL", script, "1", KV_KEY, original || "", JSON.stringify(db)])
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error("Persistent storage write failed.");
  if (result.result !== 1) { const error = new Error("Club data changed. Refresh and try again."); error.status = 409; throw error; }
}

// Request body helper
function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string" && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) {}
  }
  return new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  res.end(JSON.stringify(payload));
}

// Vercel Serverless Function Handler
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  let loaded;
  try { loaded = await getDatabase(); } catch { return sendJson(res, 503, { error: "Storage unavailable. Existing data has not been changed." }); }
  let db = loaded.db;
  if (await handleAdmin(req, res, pathname, {
    parse: parseBody, send: sendJson,
    mutate: async change => {
      const next = JSON.parse(JSON.stringify(db));
      const result = change(next);
      await saveDatabase(next, loaded.original);
      return result;
    }
  })) return;
  if (["/api/reset", "/reset"].includes(pathname)) return sendJson(res, 403, { error: "Reset is disabled to protect club history." });


  // 1. GET /api/data
  if (req.method === "GET" && (pathname === "/api/data" || pathname === "/data")) {
    const publicPlayers = (db.players || []).map(p => ({
      id: p.id,
      name: p.name,
      username: p.username,
      elo: p.elo,
      wins: p.wins || 0,
      losses: p.losses || 0
    }));

    return sendJson(res, 200, {
      success: true,
      players: publicPlayers,
      matches: db.matches || [],
      storageType: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) ? "vercel_kv" : "filesystem",
      serverTime: new Date().toISOString()
    });
  }

  // 2. POST /api/auth/signup
  if (req.method === "POST" && (pathname === "/api/auth/signup" || pathname === "/auth/signup")) {
    try {
      const body = await parseBody(req);
      const name = (body.name || "").trim();
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";

      if (!name || !username || !password) {
        return sendJson(res, 400, { error: "Name, username, and password are required." });
      }

      if (password.length < 4) {
        return sendJson(res, 400, { error: "Password must be at least 4 characters." });
      }

      const exists = (db.accounts || []).some(a => a.username.toLowerCase() === username);
      if (exists) {
        return sendJson(res, 409, { error: `Username "${username}" is already taken.` });
      }

      const playerId = Date.now();
      const newAccount = {
        id: playerId,
        name,
        username,
        password,
        createdAt: new Date().toISOString()
      };

      const newPlayer = {
        id: playerId,
        accountId: playerId,
        name,
        username,
        elo: 1000,
        wins: 0,
        losses: 0
      };

      if (!db.accounts) db.accounts = [];
      if (!db.players) db.players = [];

      db.accounts.push(newAccount);
      db.players.push(newPlayer);
      await saveDatabase(db, loaded.original);

      return sendJson(res, 201, {
        success: true,
        user: {
          id: newPlayer.id,
          name: newPlayer.name,
          username: newPlayer.username,
          elo: newPlayer.elo,
          wins: 0,
          losses: 0
        }
      });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // 3. POST /api/auth/login
  if (req.method === "POST" && (pathname === "/api/auth/login" || pathname === "/auth/login")) {
    try {
      const body = await parseBody(req);
      const username = (body.username || "").trim().toLowerCase();
      const password = body.password || "";

      const account = (db.accounts || []).find(a => a.username.toLowerCase() === username && a.password === password);
      if (!account) {
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }

      const player = (db.players || []).find(p => String(p.id) === String(account.id)) || {
        id: account.id,
        name: account.name,
        username: account.username,
        elo: 1000,
        wins: 0,
        losses: 0
      };

      return sendJson(res, 200, {
        success: true,
        user: {
          id: player.id,
          name: player.name,
          username: player.username,
          elo: player.elo,
          wins: player.wins || 0,
          losses: player.losses || 0
        }
      });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // 4. POST /api/auth/delete-account
  if (req.method === "POST" && (pathname === "/api/auth/delete-account" || pathname === "/auth/delete-account")) {
    try {
      const body = await parseBody(req);
      const userId = body.userId;

      if (!userId) {
        return sendJson(res, 400, { error: "User ID is required." });
      }

      const accIdx = (db.accounts || []).findIndex(a => String(a.id) === String(userId));
      const playerIdx = (db.players || []).findIndex(p => String(p.id) === String(userId));

      if (accIdx === -1 && playerIdx === -1) {
        return sendJson(res, 404, { error: "Account not found." });
      }

      if (accIdx === -1) return sendJson(res, 403, { error: "This roster player has no account to delete." });
      const playerName = (db.players[playerIdx] || db.accounts[accIdx] || {}).name || "Player";

      if (accIdx !== -1) db.accounts.splice(accIdx, 1);
      if (playerIdx !== -1) db.players.splice(playerIdx, 1);

      db.matches = (db.matches || []).filter(m => {
        if (!m.eloApplied && (String(m.winnerId) === String(userId) || String(m.loserId) === String(userId))) {
          return false;
        }
        return true;
      });

      await saveDatabase(db, loaded.original);

      return sendJson(res, 200, {
        success: true,
        message: `Account for ${playerName} was permanently deleted.`
      });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // 5. POST /api/matches
  if (req.method === "POST" && (pathname === "/api/matches" || pathname === "/matches")) {
    try {
      const body = await parseBody(req);
      const winnerId = body.winnerId;
      const loserId = body.loserId;
      const reporterId = body.reporterId;
      const score = (body.score || "").trim() || "Score unrecorded";

      if (!winnerId || !loserId) {
        return sendJson(res, 400, { error: "Winner and loser are required." });
      }

      if (String(winnerId) === String(loserId)) {
        return sendJson(res, 400, { error: "Winner and loser must be different players." });
      }

      const winner = (db.players || []).find(p => String(p.id) === String(winnerId));
      const loser = (db.players || []).find(p => String(p.id) === String(loserId));

      if (!winner || !loser) {
        return sendJson(res, 404, { error: "Player records not found." });
      }

      const isReporterWinner = String(reporterId) === String(winner.id);
      const isReporterLoser = String(reporterId) === String(loser.id);

      if (!isReporterWinner && !isReporterLoser) {
        return sendJson(res, 403, { error: "Only a participant can submit match results." });
      }

      const matchId = Date.now();
      const newMatch = {
        id: matchId,
        winnerId: winner.id,
        loserId: loser.id,
        winnerName: winner.name,
        loserName: loser.name,
        score,
        date: new Date().toISOString(),
        winnerChange: null,
        loserChange: null,
        confirmations: {
          [winner.id]: isReporterWinner,
          [loser.id]: isReporterLoser
        },
        eloApplied: false
      };

      if (!db.matches) db.matches = [];
      db.matches.push(newMatch);
      await saveDatabase(db, loaded.original);

      return sendJson(res, 201, { success: true, match: newMatch });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // 6. POST /api/matches/:id/confirm
  const confirmMatch = pathname.match(/\/?api\/matches\/(\d+)\/confirm/);
  if (req.method === "POST" && confirmMatch) {
    try {
      const matchId = confirmMatch[1];
      const body = await parseBody(req);
      const userId = body.userId;

      const match = (db.matches || []).find(m => String(m.id) === String(matchId));
      if (!match) return sendJson(res, 404, { error: "Match not found." });

      const isWinner = String(userId) === String(match.winnerId);
      const isLoser = String(userId) === String(match.loserId);

      if (!isWinner && !isLoser) {
        return sendJson(res, 403, { error: "Only participants can confirm this match." });
      }

      if (match.eloApplied) {
        return sendJson(res, 400, { error: "Match is already finalized." });
      }

      if (!match.confirmations) match.confirmations = {};
      if (isWinner) match.confirmations[match.winnerId] = true;
      if (isLoser) match.confirmations[match.loserId] = true;

      const winnerConfirmed = !!match.confirmations[match.winnerId];
      const loserConfirmed = !!match.confirmations[match.loserId];

      let eloApplied = false;

      if (winnerConfirmed && loserConfirmed) {
        const winner = (db.players || []).find(p => String(p.id) === String(match.winnerId));
        const loser = (db.players || []).find(p => String(p.id) === String(match.loserId));

        if (winner && loser) {
          const delta = calculateEloGain(winner.elo, loser.elo);
          winner.elo += delta;
          loser.elo = Math.max(100, loser.elo - delta);
          winner.wins = (winner.wins || 0) + 1;
          loser.losses = (loser.losses || 0) + 1;

          match.winnerChange = delta;
          match.loserChange = delta;
          match.eloApplied = true;
          eloApplied = true;
        }
      }

      await saveDatabase(db, loaded.original);
      return sendJson(res, 200, { success: true, match, eloApplied });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // 7. POST /api/matches/:id/reject
  const rejectMatch = pathname.match(/\/?api\/matches\/(\d+)\/reject/);
  if (req.method === "POST" && rejectMatch) {
    try {
      const matchId = rejectMatch[1];
      const body = await parseBody(req);
      const userId = body.userId;

      const matchIdx = (db.matches || []).findIndex(m => String(m.id) === String(matchId));
      if (matchIdx === -1) return sendJson(res, 404, { error: "Match not found." });

      const match = db.matches[matchIdx];
      if (match.verification === "admin") return sendJson(res, 403, { error: "Admin-recorded matches cannot be removed through player accounts." });
      const isWinner = String(userId) === String(match.winnerId);
      const isLoser = String(userId) === String(match.loserId);

      if (!isWinner && !isLoser) {
        return sendJson(res, 403, { error: "Unauthorized: You cannot reject this match." });
      }

      if (match.eloApplied) {
        const winner = (db.players || []).find(p => String(p.id) === String(match.winnerId));
        const loser = (db.players || []).find(p => String(p.id) === String(match.loserId));

        if (winner && match.winnerChange) {
          winner.elo = Math.max(100, winner.elo - match.winnerChange);
          winner.wins = Math.max(0, (winner.wins || 0) - 1);
        }
        if (loser && match.loserChange) {
          loser.elo += match.loserChange;
          loser.losses = Math.max(0, (loser.losses || 0) - 1);
        }
      }

      db.matches.splice(matchIdx, 1);
      await saveDatabase(db, loaded.original);

      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: "Endpoint not found" });
};

