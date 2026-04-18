const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const INDEX_FILE = path.join(__dirname, "index.html");
const LIVE_V3_FILE = path.join(__dirname, "live-v3.html");
const LIVE_FILE = path.join(__dirname, "live.html");
const LIVE_BASE64_FILE = path.join(__dirname, "live.html.b64");
const BUNDLED_HTML_FILE = path.join(__dirname, "app.html.b64");
const STORE_FILE = path.join(__dirname, "rooms-store.json");

let rooms = loadRooms();
const streamsByRoom = new Map();

function loadRooms() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (error) {
    console.warn("Could not load room store:", error.message);
    return {};
  }
}

function persistRooms() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(rooms, null, 2));
  } catch (error) {
    console.warn("Could not persist room store:", error.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, contentType, text) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function looksLikeHtml(text) {
  return text.includes("<!DOCTYPE html") || text.includes("<html");
}

function decodePlainBase64(encoded) {
  return Buffer.from(String(encoded || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

function decodeBundledHtml(encoded) {
  const trimmed = String(encoded || "").replace(/\s+/g, "");
  const zipped = Buffer.from(trimmed, "base64");
  const attempts = [
    () => zlib.gunzipSync(zipped),
    () => zlib.unzipSync(zipped),
    () => zlib.inflateSync(zipped),
    () => zlib.inflateRawSync(zipped)
  ];

  for (const decode of attempts) {
    try {
      const html = decode().toString("utf8");
      if (looksLikeHtml(html)) return html;
    } catch (error) {
      // Try the next decoding strategy.
    }
  }

  throw new Error("Could not decode bundled frontend");
}

function repairServedHtml(html) {
  let repaired = String(html || "");

  repaired = repaired.replace(
    'path: "M12 2l3.09 6.26L22 9l-5 4.87L18.18 22 12 18.77 5.82 22 7 13.87 2 9l6.91-.74L12 2z"',
    'path: "M12 2C8.4 6.6 4 9.1 4 13a5 5 0 0 0 5 5c1.25 0 2.33-.42 3-1.18V20H9v2h6v-2h-3v-3.18c.67.76 1.75 1.18 3 1.18a5 5 0 0 0 5-5c0-3.9-4.4-6.4-8-11z"'
  );

  repaired = repaired.replace(
    'path: "M12 2l4.5 6.5L22 12l-5.5 4-4.5 6.5L7.5 16 2 12l4.5-6.5L12 2z"',
    'path: "M12 2L19 12 12 22 5 12Z"'
  );

  repaired = repaired.replace(
    'path: "M12 2C9.5 2 7.5 4 7.5 6.5c0 1.58.81 2.97 2.06 3.81-.25.44-.56.86-.56 1.69 0 2.25 2.25 4 5 4s5-1.75 5-4c0-.83-.31-1.25-.56-1.69C19.69 9.47 20.5 8.08 20.5 6.5 20.5 4 18.5 2 16 2c-1 0-1.88.38-2.56 1C12.88 2.38 12 2 12 2z"',
    'path: "M12 2a4 4 0 0 0-4 4c0 .77.22 1.5.6 2.12A4.7 4.7 0 0 0 4 12.5C4 15 6 17 8.5 17c.83 0 1.62-.22 2.3-.63V20H8v2h8v-2h-2.8v-3.63c.68.41 1.47.63 2.3.63 2.5 0 4.5-2 4.5-4.5A4.7 4.7 0 0 0 15.4 8.12 3.97 3.97 0 0 0 16 6a4 4 0 0 0-4-4z"'
  );

  repaired = repaired.replace(
    'path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"',
    'path: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 2a7.95 7.95 0 0 1 5.65 2.35L6.35 17.65A8 8 0 0 1 12 4zm0 16a7.95 7.95 0 0 1-5.65-2.35L17.65 6.35A8 8 0 0 1 12 20z"'
  );

  repaired = repaired.replace(
    'function renderPredictionGrid() {\n      const editable = canEdit() && gameState.hasStarted && gameState.roundPhase === "bidding";\n      const grid = document.getElementById("predictionsGrid");',
    'function renderPredictionGrid() {\n      const editable = canEdit() && gameState.hasStarted && gameState.roundPhase === "bidding";\n      const cardCount = getCurrentCardCount();\n      const grid = document.getElementById("predictionsGrid");'
  );

  return repaired;
}

function readAppHtml() {
  if (fs.existsSync(LIVE_V3_FILE)) return repairServedHtml(fs.readFileSync(LIVE_V3_FILE, "utf8"));
  if (fs.existsSync(LIVE_FILE)) return repairServedHtml(fs.readFileSync(LIVE_FILE, "utf8"));

  if (fs.existsSync(LIVE_BASE64_FILE)) {
    const html = decodePlainBase64(fs.readFileSync(LIVE_BASE64_FILE, "utf8"));
    if (looksLikeHtml(html)) return repairServedHtml(html);
    throw new Error("Could not decode live frontend");
  }

  if (fs.existsSync(BUNDLED_HTML_FILE)) {
    return repairServedHtml(decodeBundledHtml(fs.readFileSync(BUNDLED_HTML_FILE, "utf8")));
  }

  return repairServedHtml(fs.readFileSync(INDEX_FILE, "utf8"));
}

function getRoom(code) {
  return rooms[String(code || "").toUpperCase()] || null;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms[code]);
  return code;
}

function ensureMember(room, sessionId, collaboratorName) {
  let member = room.members.find((entry) => entry.sessionId === sessionId);
  if (!member) {
    member = {
      sessionId,
      name: String(collaboratorName || "Viewer").slice(0, 40),
      role: room.members.length === 0 ? "admin" : "viewer",
      lastSeen: nowIso()
    };
    room.members.push(member);
  }

  if (collaboratorName && collaboratorName.trim()) {
    member.name = collaboratorName.trim().slice(0, 40);
  }
  member.lastSeen = nowIso();
  return member;
}

function removeMember(room, sessionId) {
  room.members = room.members.filter((member) => member.sessionId !== sessionId);
  if (room.members.length > 0 && !room.members.some((member) => member.role === "admin")) {
    room.members[0].role = "admin";
  }
}

function getMember(room, sessionId) {
  return room.members.find((member) => member.sessionId === sessionId) || null;
}

function canEditRoom(room, sessionId) {
  const member = getMember(room, sessionId);
  return !!member && (member.role === "admin" || member.role === "editor");
}

function isAdmin(room, sessionId) {
  const member = getMember(room, sessionId);
  return !!member && member.role === "admin";
}

function sanitizeGameState(gameState) {
  return gameState && typeof gameState === "object" ? gameState : null;
}

function makeSnapshot(room, sessionId) {
  const member = getMember(room, sessionId);
  return {
    code: room.code,
    version: room.version,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    yourRole: member ? member.role : "viewer",
    canEdit: !!member && (member.role === "admin" || member.role === "editor"),
    members: room.members.map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
      lastSeen: entry.lastSeen,
      you: entry.sessionId === sessionId
    })),
    gameState: room.gameState
  };
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastRoom(room) {
  const streams = streamsByRoom.get(room.code);
  if (!streams) return;
  for (const stream of streams) {
    sendSseEvent(stream.res, "room", makeSnapshot(room, stream.sessionId));
  }
}

function attachStream(room, sessionId, res) {
  const streams = streamsByRoom.get(room.code) || new Set();
  const stream = { sessionId, res };
  streams.add(stream);
  streamsByRoom.set(room.code, streams);
  sendSseEvent(res, "room", makeSnapshot(room, sessionId));

  const cleanup = () => {
    const current = streamsByRoom.get(room.code);
    if (!current) return;
    current.delete(stream);
    if (current.size === 0) streamsByRoom.delete(room.code);
  };

  res.on("close", cleanup);
  res.on("error", cleanup);
}

function getServerInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return {
    port: PORT,
    addresses
  };
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/") {
      sendText(res, 200, "text/html; charset=utf-8", readAppHtml());
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/server-info") {
      sendJson(res, 200, getServerInfo());
      return;
    }

    if (req.method === "POST" && pathname === "/api/rooms") {
      const body = await readJsonBody(req);
      if (!body.sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }

      const code = generateRoomCode();
      const createdAt = nowIso();
      const room = {
        code,
        createdAt,
        updatedAt: createdAt,
        version: 1,
        members: [
          {
            sessionId: body.sessionId,
            name: String(body.collaboratorName || "Admin").slice(0, 40),
            role: "admin",
            lastSeen: createdAt
          }
        ],
        gameState: sanitizeGameState(body.gameState)
      };

      rooms[code] = room;
      persistRooms();
      sendJson(res, 201, makeSnapshot(room, body.sessionId));
      return;
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/([a-z-]+))?$/i);
    if (roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const action = (roomMatch[2] || "").toLowerCase();
      const room = getRoom(code);

      if (!room) {
        sendJson(res, 404, { error: "Room not found" });
        return;
      }

      if (req.method === "GET" && action === "events") {
        const sessionId = String(url.searchParams.get("sessionId") || "");
        const collaboratorName = String(url.searchParams.get("name") || "");
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        ensureMember(room, sessionId, collaboratorName);
        persistRooms();

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        });
        res.write("\n");
        attachStream(room, sessionId, res);
        return;
      }

      const body = ["POST", "PUT"].includes(req.method) ? await readJsonBody(req) : {};

      if (req.method === "POST" && action === "join") {
        if (!body.sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        ensureMember(room, body.sessionId, body.collaboratorName);
        room.updatedAt = nowIso();
        room.version += 1;
        persistRooms();
        broadcastRoom(room);
        sendJson(res, 200, makeSnapshot(room, body.sessionId));
        return;
      }

      if (req.method === "POST" && action === "leave") {
        if (!body.sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        removeMember(room, body.sessionId);
        room.updatedAt = nowIso();
        room.version += 1;

        if (room.members.length === 0) delete rooms[code];

        persistRooms();
        if (rooms[code]) broadcastRoom(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && action === "presence") {
        if (!body.sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        ensureMember(room, body.sessionId, body.collaboratorName);
        persistRooms();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && action === "") {
        const sessionId = String(url.searchParams.get("sessionId") || "");
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        ensureMember(room, sessionId, String(url.searchParams.get("name") || ""));
        persistRooms();
        sendJson(res, 200, makeSnapshot(room, sessionId));
        return;
      }

      if (req.method === "POST" && action === "update") {
        if (!body.sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }

        ensureMember(room, body.sessionId, body.collaboratorName);
        if (!canEditRoom(room, body.sessionId)) {
          sendJson(res, 403, { error: "You do not have permission to edit this room" });
          return;
        }

        room.gameState = sanitizeGameState(body.gameState);
        room.updatedAt = nowIso();
        room.version += 1;
        persistRooms();
        broadcastRoom(room);
        sendJson(res, 200, makeSnapshot(room, body.sessionId));
        return;
      }

      if (req.method === "POST" && action === "permissions") {
        if (!body.sessionId || !body.targetSessionId || !body.role) {
          sendJson(res, 400, { error: "sessionId, targetSessionId, and role are required" });
          return;
        }

        ensureMember(room, body.sessionId, body.collaboratorName);
        if (!isAdmin(room, body.sessionId)) {
          sendJson(res, 403, { error: "Only the admin can change collaborator permissions" });
          return;
        }

        const target = getMember(room, body.targetSessionId);
        if (!target) {
          sendJson(res, 404, { error: "Collaborator not found" });
          return;
        }

        if (!["viewer", "editor"].includes(body.role)) {
          sendJson(res, 400, { error: "Invalid role" });
          return;
        }

        if (target.role === "admin") {
          sendJson(res, 400, { error: "Admin role cannot be changed here" });
          return;
        }

        target.role = body.role;
        target.lastSeen = nowIso();
        room.updatedAt = nowIso();
        room.version += 1;
        persistRooms();
        broadcastRoom(room);
        sendJson(res, 200, makeSnapshot(room, body.sessionId));
        return;
      }

      notFound(res);
      return;
    }

    notFound(res);
  } catch (error) {
    console.error("Request failed:", error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  const info = getServerInfo();
  console.log(`Judgment room server running on http://localhost:${PORT}`);
  info.addresses.forEach((address) => {
    console.log(`LAN access: http://${address}:${PORT}`);
  });
});
