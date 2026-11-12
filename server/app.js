import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createGame, GameError } from "./game.js";
import { createWitnessService, createRateLimiter, loadLlmConfig } from "./witness.js";
import { createArchiveService } from "./archive.js";
import { createPayments, loadPayPalConfig } from "./paypal.js";

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MAX_BODY = 32 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

export function createApp({
  db = openDb(), llmConfig = loadLlmConfig(), paypalConfig = loadPayPalConfig(), fetchImpl = fetch,
  witnessLimiter = createRateLimiter({ max: 8, windowMs: 60_000 }),
  archiveLimiter = createRateLimiter({ max: 8, windowMs: 60_000 }),
} = {}) {
  const game = createGame(db);
  const witnesses = createWitnessService({ game, llmConfig, fetchImpl, rateLimiter: witnessLimiter });
  const archive = createArchiveService({ game, llmConfig, fetchImpl, rateLimiter: archiveLimiter });
  const payments = createPayments({ db, game, config: paypalConfig, fetchImpl });

  const send = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new GameError("Request too large.", 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  const parseJson = (raw) => {
    if (!raw) return {};
    try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; }
    catch { throw new GameError("Invalid JSON body."); }
  };
  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  async function serveStatic(req, res, pathname) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep)) { res.writeHead(403); return res.end("Forbidden"); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  }

  async function route(req, res, pathname) {
    const m = req.method;
    if (m === "GET" && pathname === "/api/config") {
      return send(res, 200, {
        liveAi: !!llmConfig,
        witnessMode: llmConfig ? "live-ai" : "scripted",
        paypal: payments.publicConfig(),
        sandbox: true,
      });
    }
    // Webhook needs the raw body for signature verification.
    if (m === "POST" && pathname === "/api/paypal/webhook") {
      const raw = await readBody(req);
      return send(res, 200, await payments.handleWebhook({ headers: req.headers, rawBody: raw }));
    }
    if (m === "GET" && pathname === "/api/state") return send(res, 200, game.getState(bearer(req)));
    if (m !== "POST") throw new GameError("Not found.", 404);

    const body = parseJson(await readBody(req));
    const token = bearer(req);
    switch (pathname) {
      case "/api/rooms": return send(res, 200, game.createRoom({ name: body.name, mode: body.mode }));
      case "/api/rooms/join": return send(res, 200, game.joinRoom({ code: body.code, name: body.name }));
      case "/api/start": return send(res, 200, game.startInvestigation(token));
      case "/api/share": return send(res, 200, game.shareClue(token, body.clueId));
      case "/api/witness": return send(res, 200, await witnesses.ask(token, {
        witnessId: body.witnessId, question: body.question, forceScripted: body.scripted === true,
      }));
      case "/api/archive": return send(res, 200, await archive.ask(token, { question: body.question }));
      case "/api/accuse": return send(res, 200, game.accuse(token, {
        suspect: body.suspect, explanation: body.explanation, clueIds: body.clueIds,
      }));
      case "/api/paypal/create-order": return send(res, 200, await payments.createOrder(token));
      case "/api/paypal/capture-order": return send(res, 200, await payments.captureOrder(token, body.orderId));
      default: throw new GameError("Not found.", 404);
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname.startsWith("/api/")) return await route(req, res, pathname);
      if (req.method !== "GET") { res.writeHead(405); return res.end(); }
      return await serveStatic(req, res, pathname);
    } catch (e) {
      if (e instanceof GameError) return send(res, e.status, { error: e.message });
      console.error("Unexpected error:", e);
      return send(res, 500, { error: "Something went wrong on the server." });
    }
  });
  return { server, game, payments, db };
}
