const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const INDEX_FILE = path.join(__dirname, "index.html");
const LIVE_FILE = path.join(__dirname, "live.html");
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
  fs.writeFileSync(STORE_FILE, JSON.stringify(rooms, null, 2));
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

function decodeBundledHtml(encoded) {
  const trimmed = String(encoded || "").replace(/\s+/g, "");
  const zipped = Buffer.from(trimmed, "base64");
  const attempts = [
    ["gunzip", () => zlib.gunzipSync(zipped)],
    ["unzip", () => zlib.unzipSync(zipped)],
    ["inflate", () => zlib.inflateSync(zipped)],
    ["inflateRaw", () => zlib.inflateRawSync(zipped)]
  ];

  for (const [, decode] of attempts) {
    try {
      const html = decode().toString("utf8");
      if (html.includes("<!DOCTYPE html") || html.includes("<html")) return html;
    } catch (error) {
      // Keep trying other compression formats.
    }
  }

  const plain = zipped.toString("utf8");
  if (plain.includes("<!DOCTYPE html") || plain.includes("<html")) return plain;

  throw new Error("Could not decode bundled frontend");
}

function readAppHtml() {
  if (fs.existsSync(LIVE_FILE)) {
    return fs.readFileSync(LIVE_FILE, "utf8");
  }

  if (fs.existsSync(BUNDLED_HTML_FILE)) {
    return decodeBundledHtml(fs.readFileSync(BUNDLED_HTML_FILE, "utf8"));
  }

  return fs.readFileSync(INDEX_FILE, "utf8");
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

        if (room.members.length === 0) {
          delete rooms[code];
        }

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
