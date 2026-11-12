import { randomUUID } from "node:crypto";
import { GameError } from "./game.js";

/** Sandbox only. Refuses to run against a non-sandbox PayPal host so real money can never be charged by accident. */
export function loadPayPalConfig(env = process.env) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) return null;
  const baseUrl = env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
  if (!new URL(baseUrl).hostname.includes("sandbox")) {
    throw new Error("PAYPAL_BASE_URL must be a PayPal sandbox host. Live payments are disabled in this project.");
  }
  return {
    clientId, secret, baseUrl,
    amount: Number(env.PRICE_AMOUNT || "4.99").toFixed(2),
    currency: (env.PRICE_CURRENCY || "USD").toUpperCase(),
    webhookId: env.PAYPAL_WEBHOOK_ID || null,
  };
}

const money = (v) => Number(v).toFixed(2);
const ORDER_ID_RE = /^[A-Za-z0-9-]{5,64}$/;

export function createPayments({ db, game, config = loadPayPalConfig(), fetchImpl = fetch, now = () => Date.now() }) {
  let cachedToken = null; // { value, expiresAt }

  const purchaseByOrder = db.prepare("SELECT * FROM purchases WHERE paypal_order_id = ?");
  const roomById = db.prepare("SELECT * FROM rooms WHERE id = ?");

  function requireConfig() {
    if (!config) throw new GameError("Payments are not configured on this server (missing PayPal sandbox keys).", 503);
    return config;
  }

  async function accessToken() {
    const cfg = requireConfig();
    if (cachedToken && cachedToken.expiresAt > now() + 30_000) return cachedToken.value;
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch {
      throw new GameError("Could not reach PayPal. Please try again.", 502);
    }
    if (!res.ok) throw new GameError("PayPal rejected the server credentials. Check the sandbox keys.", 502);
    const data = await res.json();
    cachedToken = { value: data.access_token, expiresAt: now() + (Number(data.expires_in) || 300) * 1000 };
    return cachedToken.value;
  }

  /** Returns { ok, status, data }. Network failures become a clear 502. */
  async function pp(path, { method = "GET", body, requestId } = {}) {
    const cfg = requireConfig();
    const token = await accessToken();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId; // PayPal-side idempotency
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method, headers, signal: AbortSignal.timeout(20_000),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GameError("Could not reach PayPal. Please try again.", 502);
    }
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  function hostOfMultiplayerRoom(token) {
    const { player, room } = game.authenticate(token);
    if (!player.is_host) throw new GameError("Only the host can purchase the adventure.", 403);
    if (room.mode !== "multiplayer") throw new GameError("Solo demonstration mode is free; no purchase is needed.", 400);
    return { player, room };
  }

  /** Step 1-2 of the flow: server creates the order at the server-controlled price. */
  async function createOrder(token) {
    const cfg = requireConfig();
    const { player, room } = hostOfMultiplayerRoom(token);
    if (room.purchase_status === "paid") throw new GameError("This adventure is already purchased.", 409);
    if (room.phase !== "lobby") throw new GameError("Purchase must happen in the lobby.", 409);
    const r = await pp("/v2/checkout/orders", {
      method: "POST",
      requestId: randomUUID(),
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: room.code,
          custom_id: room.id, // ties the payment to THIS room
          description: "Alibi AI - The Last Signal (sandbox test purchase)",
          amount: { currency_code: cfg.currency, value: cfg.amount },
        }],
      },
    });
    if (!r.ok || !r.data?.id) throw new GameError("PayPal could not create the order. Please try again.", 502);
    db.prepare(
      "INSERT INTO purchases (room_id, owner_player_id, paypal_order_id, amount, currency, status) VALUES (?,?,?,?,?,'created')"
    ).run(room.id, player.id, r.data.id, cfg.amount, cfg.currency);
    return { orderId: r.data.id, amount: cfg.amount, currency: cfg.currency };
  }

  /**
   * Decide from PayPal's own order record (fetched server-to-server) whether to grant access.
   * Returns 'paid' | 'pending' | 'unpaid'. Throws 402 when the record contradicts what we expect.
   */
  function evaluateAndGrant(order, purchase) {
    const cfg = requireConfig();
    const room = roomById.get(purchase.room_id);
    const unit = order?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (!capture) return "unpaid";
    if (capture.status === "PENDING") return "pending";
    if (order.status !== "COMPLETED" || capture.status !== "COMPLETED") return "unpaid";

    const problems = [];
    if (order.id !== purchase.paypal_order_id) problems.push("order id mismatch");
    if (unit.custom_id !== room.id) problems.push("payment is not associated with this room");
    if (money(capture.amount?.value) !== money(purchase.amount) || money(purchase.amount) !== cfg.amount) problems.push("amount mismatch");
    if ((capture.amount?.currency_code || "").toUpperCase() !== purchase.currency || purchase.currency !== cfg.currency) problems.push("currency mismatch");
    if (!capture.id) problems.push("missing capture id");
    if (problems.length) {
      db.prepare("UPDATE purchases SET status='failed' WHERE id = ? AND status <> 'verified'").run(purchase.id);
      throw new GameError(`Payment could not be verified (${problems.join(", ")}). Access was not granted.`, 402);
    }

    // Grant exactly once, atomically.
    db.exec("BEGIN IMMEDIATE");
    try {
      const fresh = purchaseByOrder.get(purchase.paypal_order_id);
      if (fresh.status !== "verified") {
        db.prepare("UPDATE purchases SET status='verified', paypal_capture_id=? WHERE id=?").run(capture.id, purchase.id);
      }
      db.prepare("UPDATE rooms SET purchase_status='paid' WHERE id=?").run(room.id);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      // UNIQUE(paypal_capture_id) violated => this capture already unlocked something else.
      throw new GameError("This payment has already been used.", 409);
    }
    return "paid";
  }

  /** Steps 3-6: capture, then verify with PayPal before unlocking anything. */
  async function captureOrder(token, orderId) {
    requireConfig();
    const { room } = hostOfMultiplayerRoom(token);
    if (typeof orderId !== "string" || !ORDER_ID_RE.test(orderId)) throw new GameError("Invalid order.", 400);
    const purchase = purchaseByOrder.get(orderId);
    if (!purchase || purchase.room_id !== room.id) throw new GameError("Order not found for this room.", 404);

    // Idempotent: repeated requests never create a second entitlement.
    if (purchase.status === "verified" || room.purchase_status === "paid") return { status: "paid" };

    const cap = await pp(`/v2/checkout/orders/${orderId}/capture`, { method: "POST", requestId: `capture-${orderId}`, body: {} });
    const alreadyCaptured = cap.status === 422 && cap.data?.details?.some?.((d) => d.issue === "ORDER_ALREADY_CAPTURED");
    if (!cap.ok && !alreadyCaptured) {
      const notApproved = cap.data?.details?.some?.((d) => d.issue === "ORDER_NOT_APPROVED");
      throw new GameError(
        notApproved ? "The order has not been approved in PayPal yet." : "PayPal could not complete the payment. You have not been charged for access.",
        notApproved ? 409 : 402,
      );
    }
    // Never trust the capture response alone: re-read the order from PayPal.
    const order = await pp(`/v2/checkout/orders/${orderId}`);
    if (!order.ok) throw new GameError("Could not verify the payment with PayPal. Please refresh and try again.", 502);
    const status = evaluateAndGrant(order.data, purchase);
    return { status };
  }

  /** Verified webhooks reconcile payments (e.g. browser closed after approval). */
  async function handleWebhook({ headers, rawBody }) {
    const cfg = requireConfig();
    if (!cfg.webhookId) throw new GameError("Webhook verification is not configured.", 501);
    let event;
    try { event = JSON.parse(rawBody); } catch { throw new GameError("Invalid webhook body.", 400); }
    const h = (k) => headers[k];
    const v = await pp("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"), webhook_id: cfg.webhookId, webhook_event: event,
      },
    });
    if (!v.ok || v.data?.verification_status !== "SUCCESS") throw new GameError("Webhook signature not verified.", 400);

    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
      const purchase = orderId ? purchaseByOrder.get(orderId) : null;
      if (purchase) {
        const order = await pp(`/v2/checkout/orders/${orderId}`);
        if (order.ok) evaluateAndGrant(order.data, purchase);
      }
    }
    return { received: true };
  }

  return {
    createOrder, captureOrder, handleWebhook,
    enabled: !!config,
    publicConfig: () => config && { clientId: config.clientId, amount: config.amount, currency: config.currency },
  };
}
