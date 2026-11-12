import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";

async function boot(opts = {}) {
  const app = createApp({ db: openDb(":memory:"), llmConfig: null, paypalConfig: null, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, text };
  };
  return { ...app, base, call, close: () => app.server.close() };
}

test("static page and config are served; unknown routes 404; traversal blocked", async (t) => {
  const s = await boot(); t.after(s.close);
  const home = await fetch(s.base + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Alibi AI/);
  const cfg = await s.call("GET", "/api/config");
  assert.equal(cfg.json.witnessMode, "scripted");
  assert.equal(cfg.json.paypal, null);
  assert.equal((await s.call("GET", "/api/nope")).status, 404);
  assert.notEqual((await fetch(s.base + "/..%2f..%2fetc/passwd")).status, 200);
  assert.equal((await fetch(s.base + "/%2e%2e/package.json")).status === 200, false);
});

test("full SOLO game over HTTP: start, witness, archive, share, accuse, reveal", async (t) => {
  const s = await boot(); t.after(s.close);
  const { json: room } = await s.call("POST", "/api/rooms", { body: { name: "Sam", mode: "solo" } });
  const token = room.token;
  const st = await s.call("POST", "/api/start", { token });
  assert.equal(st.json.room.phase, "investigation");
  assert.equal(st.json.privateClues.length, 6);

  const w = await s.call("POST", "/api/witness", { token, body: { witnessId: "ivo", question: "Could someone operate F2 from the west gantry?" } });
  assert.equal(w.status, 200);
  assert.equal(w.json.mode, "scripted");
  assert.match(w.json.answer, /freight dock/);

  const a = await s.call("POST", "/api/archive", { token, body: { question: "Which records contradict Mara's account of being on the west gantry?" } });
  assert.equal(a.status, 200);
  assert.equal(a.json.mode, "keyword-retrieval");
  assert.ok(a.json.sourceIds.includes("C2"), "F2 terminal clue should be retrieved for the spec's example question");

  await s.call("POST", "/api/share", { token, body: { clueId: "C2" } });
  const acc = await s.call("POST", "/api/accuse", { token, body: { suspect: "mara", explanation: "F2 is at the freight dock, six minutes from the gantry.", clueIds: ["C2"] } });
  assert.equal(acc.status, 200);
  assert.equal(acc.json.reveal.accusation.correct, true);
  assert.equal(acc.json.messages.length, 1); // witness history persisted
});

test("auth and validation errors are clear JSON errors", async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.call("GET", "/api/state")).status, 401);
  assert.equal((await s.call("GET", "/api/state", { token: "x".repeat(64) })).status, 401);
  assert.equal((await s.call("POST", "/api/rooms", { body: { name: "", mode: "solo" } })).status, 400);
  const bad = await fetch(s.base + "/api/rooms", { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  const big = await fetch(s.base + "/api/rooms", { method: "POST", body: JSON.stringify({ name: "x".repeat(40_000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  const r = await s.call("POST", "/api/paypal/create-order", { token: (await s.call("POST", "/api/rooms", { body: { name: "A", mode: "multiplayer" } })).json.token });
  assert.equal(r.status, 503); // payments not configured: clear error
});

test("MULTIPLAYER over HTTP: privacy on the wire and archive permission filtering", async (t) => {
  const s = await boot(); t.after(s.close);
  const host = (await s.call("POST", "/api/rooms", { body: { name: "Ana", mode: "multiplayer" } })).json;
  const p2 = (await s.call("POST", "/api/rooms/join", { body: { code: host.code.toLowerCase(), name: "Ben" } })).json;
  // Unpaid: cannot start.
  assert.equal((await s.call("POST", "/api/start", { token: host.token })).status, 402);
  s.db.prepare("UPDATE rooms SET purchase_status='paid' WHERE code=?").run(host.code);
  assert.equal((await s.call("POST", "/api/start", { token: host.token })).status, 200);

  // Ben (records) must not see Ana's (systems) clues in ANY response text.
  const benState = await s.call("GET", "/api/state", { token: p2.token });
  assert.ok(!benState.text.includes("Freight reader log") && !benState.text.includes("terminal F2"));
  // Archive for Ben only retrieves Ben's clues, never Ana's unshared ones.
  const ask = await s.call("POST", "/api/archive", { token: p2.token, body: { question: "freight reader badge terminal F2 dock" } });
  assert.ok(!ask.text.includes("terminal F2") && !ask.json.sourceIds.includes("C1") && !ask.json.sourceIds.includes("C2"));
  // After Ana shares C2, Ben's archive can retrieve it.
  await s.call("POST", "/api/share", { token: host.token, body: { clueId: "C2" } });
  const ask2 = await s.call("POST", "/api/archive", { token: p2.token, body: { question: "freight reader badge terminal F2 dock" } });
  assert.ok(ask2.json.sourceIds.includes("C2"));
  assert.ok(!ask2.json.sourceIds.includes("C1")); // still private
  // Ben cannot accuse (host only) and cannot share Ana's clue.
  assert.equal((await s.call("POST", "/api/share", { token: p2.token, body: { clueId: "C1" } })).status, 403);
  assert.equal((await s.call("POST", "/api/accuse", { token: p2.token, body: { suspect: "mara", explanation: "because reasons here", clueIds: ["C2"] } })).status, 403);
});

test("witness rate limit returns 429 over HTTP", async (t) => {
  const { createRateLimiter } = await import("../server/witness.js");
  const s = await boot({ witnessLimiter: createRateLimiter({ max: 2, windowMs: 60_000 }) }); t.after(s.close);
  const token = (await s.call("POST", "/api/rooms", { body: { name: "Sam", mode: "solo" } })).json.token;
  await s.call("POST", "/api/start", { token });
  const ask = () => s.call("POST", "/api/witness", { token, body: { witnessId: "jules", question: "Where were you at 21:12?" } });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
});

test("archive with live AI: citations validated; fake citations fall back to retrieval-only", async (t) => {
  const cfg = { apiKey: "k", provider: "openai-compatible", baseUrl: "http://x", model: "m", timeoutMs: 1000 };
  const reply = (content) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
  for (const [content, expectMode] of [
    ['{"answer":"F2 is at the dock.","sourceIds":["C2"]}', "live-ai+keyword-retrieval"],
    ['{"answer":"Mara did it.","sourceIds":["C5"]}', "keyword-retrieval"], // C5 not retrievable/permitted -> rejected
    ["garbage", "keyword-retrieval"],
  ]) {
    const s = await boot({ llmConfig: cfg, fetchImpl: reply(content) });
    const token = (await s.call("POST", "/api/rooms", { body: { name: "Sam", mode: "solo" } })).json.token;
    await s.call("POST", "/api/start", { token });
    const r = await s.call("POST", "/api/archive", { token, body: { question: "terminal F2 freight dock" } });
    assert.equal(r.json.mode, expectMode, content);
    s.close();
  }
});
