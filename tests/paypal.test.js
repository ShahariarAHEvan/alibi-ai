import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createGame, GameError } from "../server/game.js";
import { createPayments, loadPayPalConfig } from "../server/paypal.js";

const CFG = {
  clientId: "cid", secret: "sec", baseUrl: "https://api-m.sandbox.paypal.com",
  amount: "4.99", currency: "USD", webhookId: "WH1",
};

/** A pretend PayPal sandbox. `tweak(order)` lets a test make PayPal return something odd. */
function mockPayPal({ tweak = (o) => o, failOn = null } = {}) {
  const orders = new Map();
  const calls = [];
  let n = 0;
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method || "GET";
    calls.push({ path, method, headers: opts.headers || {}, body: opts.body });
    if (failOn && failOn(path, method)) throw new Error("network down");
    if (path === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (path === "/v1/notifications/verify-webhook-signature")
      return json(200, { verification_status: JSON.parse(opts.body).transmission_sig === "good" ? "SUCCESS" : "FAILURE" });
    if (path === "/v2/checkout/orders" && method === "POST") {
      const id = `ORDER${++n}ABC`;
      orders.set(id, { unit: JSON.parse(opts.body).purchase_units[0], approved: false, captured: false });
      return json(201, { id, status: "CREATED" });
    }
    const m = path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    const o = m && orders.get(m[1]);
    if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
    if (m[2]) {
      if (!o.approved) return json(422, { details: [{ issue: "ORDER_NOT_APPROVED" }] });
      if (o.captured) return json(422, { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      o.captured = true;
      return json(201, { id: m[1], status: "COMPLETED" });
    }
    const order = {
      id: m[1],
      status: o.captured ? "COMPLETED" : o.approved ? "APPROVED" : "CREATED",
      purchase_units: [{
        custom_id: o.unit.custom_id,
        amount: o.unit.amount,
        payments: o.captured
          ? { captures: [{ id: `CAP-${m[1]}`, status: "COMPLETED", amount: { ...o.unit.amount, value: o.unit.amount.value, currency_code: o.unit.amount.currency_code } }] }
          : undefined,
      }],
    };
    return json(200, tweak(order));
  };
  return { fetchImpl, calls, approve: (id) => { orders.get(id).approved = true; } };
}

function setup(mockOpts) {
  const db = openDb(":memory:");
  const game = createGame(db);
  const pp = mockPayPal(mockOpts);
  const pay = createPayments({ db, game, config: CFG, fetchImpl: pp.fetchImpl });
  const host = game.createRoom({ name: "Ana", mode: "multiplayer" });
  const guest = game.joinRoom({ code: host.code, name: "Ben" });
  return { db, game, pp, pay, host, guest };
}

const rejects = (p, status) =>
  assert.rejects(p, (e) => e instanceof GameError && e.status === status, `expected GameError ${status}`);
const paidStatus = (game, t) => game.getState(t).room.purchaseStatus;

test("happy path: create -> approve -> capture -> verified -> room paid; then game can start", async () => {
  const { game, pp, pay, host, guest } = setup();
  const { orderId, amount, currency } = await pay.createOrder(host.token);
  assert.equal(amount, "4.99");
  assert.equal(currency, "USD");
  assert.equal(paidStatus(game, host.token), "unpaid");
  pp.approve(orderId);
  const r = await pay.captureOrder(host.token, orderId);
  assert.equal(r.status, "paid");
  assert.equal(paidStatus(game, host.token), "paid");
  assert.equal(paidStatus(game, guest.token), "paid"); // guests don't pay separately
  assert.equal(game.startInvestigation(host.token).room.phase, "investigation");
});

test("price is set by the server, never by the browser", async () => {
  const { pp, pay, host } = setup();
  await pay.createOrder(host.token);
  const create = pp.calls.find((c) => c.path === "/v2/checkout/orders" && c.method === "POST");
  const body = JSON.parse(create.body);
  assert.equal(body.purchase_units[0].amount.value, "4.99");
  assert.equal(body.purchase_units[0].amount.currency_code, "USD");
  assert.ok(create.headers["PayPal-Request-Id"]);
});

test("a browser success message alone grants nothing; cancelled/abandoned stays unpaid", async () => {
  const { game, pay, host } = setup();
  await pay.createOrder(host.token); // user opens PayPal, then cancels: capture is never called
  assert.equal(paidStatus(game, host.token), "unpaid");
  await rejects(pay.captureOrder(host.token, "FAKEORDER123"), 404); // forged order id
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("capture before PayPal approval is refused and stays unpaid", async () => {
  const { game, pay, host } = setup();
  const { orderId } = await pay.createOrder(host.token);
  await rejects(pay.captureOrder(host.token, orderId), 409);
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("repeated capture requests never create duplicate entitlements", async () => {
  const { db, pp, pay, host } = setup();
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  const results = await Promise.all([pay.captureOrder(host.token, orderId), pay.captureOrder(host.token, orderId)]);
  assert.ok(results.every((r) => r.status === "paid"));
  await pay.captureOrder(host.token, orderId);
  const rows = db.prepare("SELECT * FROM purchases WHERE status='verified'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paypal_capture_id, `CAP-${orderId}`);
});

test("refreshing preserves a completed purchase (status comes from the database)", async () => {
  const { game, pp, pay, host } = setup();
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  await pay.captureOrder(host.token, orderId);
  assert.equal(paidStatus(game, host.token), "paid"); // a fresh getState = a page refresh
  await rejects(pay.createOrder(host.token), 409); // cannot buy twice
});

test("pending capture stays unpaid", async () => {
  const tweak = (o) => { o.purchase_units[0].payments.captures[0].status = "PENDING"; return o; };
  const { game, pp, pay, host } = setup({ tweak });
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  const r = await pay.captureOrder(host.token, orderId);
  assert.equal(r.status, "pending");
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("declined / not-completed order stays unpaid", async () => {
  const tweak = (o) => { o.purchase_units[0].payments.captures[0].status = "DECLINED"; return o; };
  const { game, pp, pay, host } = setup({ tweak });
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  const r = await pay.captureOrder(host.token, orderId);
  assert.equal(r.status, "unpaid");
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("wrong amount from PayPal is rejected and marked failed", async () => {
  const tweak = (o) => { o.purchase_units[0].payments.captures[0].amount.value = "0.01"; return o; };
  const { db, game, pp, pay, host } = setup({ tweak });
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  await rejects(pay.captureOrder(host.token, orderId), 402);
  assert.equal(paidStatus(game, host.token), "unpaid");
  assert.equal(db.prepare("SELECT status FROM purchases").get().status, "failed");
});

test("wrong currency is rejected", async () => {
  const tweak = (o) => { o.purchase_units[0].payments.captures[0].amount.currency_code = "CAD"; return o; };
  const { game, pp, pay, host } = setup({ tweak });
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  await rejects(pay.captureOrder(host.token, orderId), 402);
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("payment associated with a different room is rejected", async () => {
  const tweak = (o) => { o.purchase_units[0].custom_id = "some-other-room"; return o; };
  const { game, pp, pay, host } = setup({ tweak });
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  await rejects(pay.captureOrder(host.token, orderId), 402);
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("an order from room A cannot unlock room B", async () => {
  const { db, game, pp, pay, host } = setup();
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  const hostB = game.createRoom({ name: "Zed", mode: "multiplayer" });
  await rejects(pay.captureOrder(hostB.token, orderId), 404);
  assert.equal(paidStatus(game, hostB.token), "unpaid");
});

test("only the host can buy; solo mode is free and separate from purchases", async () => {
  const { game, pay, host, guest } = setup();
  await rejects(pay.createOrder(guest.token), 403);
  const solo = game.createRoom({ name: "Sam", mode: "solo" });
  await rejects(pay.createOrder(solo.token), 400);
  assert.equal(game.startInvestigation(solo.token).room.purchaseStatus, "unpaid");
});

test("PayPal outage gives a clear error and grants nothing", async () => {
  const { game, pay, host } = setup({ failOn: (p) => p === "/v2/checkout/orders" });
  await rejects(pay.createOrder(host.token), 502);
  assert.equal(paidStatus(game, host.token), "unpaid");
});

test("missing keys: clear 503, and live PayPal host is refused", async () => {
  const db = openDb(":memory:");
  const game = createGame(db);
  const pay = createPayments({ db, game, config: null });
  const host = game.createRoom({ name: "Ana", mode: "multiplayer" });
  await rejects(pay.createOrder(host.token), 503);
  assert.equal(pay.enabled, false);
  assert.equal(loadPayPalConfig({}), null);
  assert.throws(() => loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_BASE_URL: "https://api-m.paypal.com" }), /sandbox/);
  assert.equal(loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).amount, "4.99");
});

test("access token is cached between calls", async () => {
  const { pp, pay, host } = setup();
  await pay.createOrder(host.token);
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  await pay.captureOrder(host.token, orderId);
  assert.equal(pp.calls.filter((c) => c.path === "/v1/oauth2/token").length, 1);
});

test("webhook: rejects bad signatures; verified completed-capture event reconciles a payment", async () => {
  const { game, pp, pay, host } = setup();
  const { orderId } = await pay.createOrder(host.token);
  pp.approve(orderId);
  // Simulate: host approved and PayPal captured, but the browser never called our capture endpoint.
  await pp.fetchImpl(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`, { method: "POST" });
  const body = JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: orderId } } } });
  await rejects(pay.handleWebhook({ headers: { "paypal-transmission-sig": "forged" }, rawBody: body }), 400);
  assert.equal(paidStatus(game, host.token), "unpaid");
  await pay.handleWebhook({ headers: { "paypal-transmission-sig": "good" }, rawBody: body });
  assert.equal(paidStatus(game, host.token), "paid");
  await pay.handleWebhook({ headers: { "paypal-transmission-sig": "good" }, rawBody: body }); // duplicate event
  assert.equal(paidStatus(game, host.token), "paid");
});
