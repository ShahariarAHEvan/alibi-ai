# Alibi AI

**A mystery night with AI witnesses and secrets only your friends know.**

Alibi AI is a browser-based, three-player cooperative mystery game. Each player is an investigator holding *private* evidence. You question AI witnesses in your own words, decide what to share, search the evidence archive, and agree on an accusation. One host buys the adventure through **PayPal (sandbox)** and invites friends with a room code.

The first adventure, **The Last Signal**, is hand-authored: at 21:12 the lights go out at Blackridge Research Station and a valuable scanner vanishes. Three suspects, three alibis, six clues, two witnesses.

> **Status: hackathon prototype.** Payments use the PayPal **sandbox** with test funds only. The code refuses to talk to PayPal's live API.

Built for the *Build What's Next with PayPal and AI* hackathon.

## What it does

- **Private perspectives.** Three roles (Systems analyst, Records specialist, Field investigator) each hold two clues nobody else can see until the owner shares them. The server enforces this; the browser never receives clues it isn't allowed to show.
- **AI witnesses with limited knowledge.** Jules Hart (security) and Ivo Bell (maintenance) answer free-text questions. Each witness's prompt contains *only that witness's facts*, tagged observed / belief / unknown. The solution is never sent to a model.
- **Evidence archive.** Ask questions about the evidence *you* can see. Retrieval is **keyword search with a small synonym list**, not embedding-based semantic search. Permission filtering happens *before* retrieval and before anything reaches the model; the AI summary's citations are validated.
- **PayPal sandbox purchase.** The server creates the order at a server-controlled price, captures it, then re-reads the order from PayPal and verifies status, capture, amount, currency and room before unlocking anything. A browser "success" message alone never grants access.
- **Solo demonstration mode.** Free, clearly labelled, shows all three files so one person can test the whole case. Kept separate from purchased sessions.
- **Reveal.** After the host submits the (final) accusation, the game shows the true timeline and explains which evidence is strong and which is weak (a badge scan or a jacket colour is not proof).

## Run it yourself

Requires **Node.js 22.5 or newer** (the npm scripts pass `--experimental-sqlite`, which Node 22.5-22.12 needs; newer versions accept it). There are **no npm dependencies to install**; the app uses Node's built-in HTTP server and built-in SQLite (`node:sqlite`, which Node 22 flags as experimental).

```bash
git clone <this repo>
cd alibi-ai
cp .env.example .env      # Windows: copy .env.example .env
# edit .env (see below), then:
npm start
```

Open <http://localhost:3000>.

### Configuration (`.env`)

| Setting | Purpose | If missing |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal **sandbox** app credentials | Purchasing is disabled; solo demo still works |
| `LLM_API_KEY` | Key for the AI witnesses and archive summaries | Witnesses run in **SCRIPTED** mode (labelled in the UI) |
| `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL` | `openai-compatible` (default, e.g. Google AI Studio/Gemini, OpenAI) or `anthropic` | Defaults to Gemini's OpenAI-compatible endpoint |
| `PRICE_AMOUNT`, `PRICE_CURRENCY` | Sandbox price (default 4.99 USD, an illustrative test price) | Defaults |
| `PAYPAL_WEBHOOK_ID` | Enables the optional webhook endpoint | Webhook returns 501 |

The server prints on startup whether it is in live-AI or scripted mode and whether PayPal is configured.

### Trying the PayPal flow

1. In the [PayPal developer dashboard](https://developer.paypal.com) (Sandbox), copy your app's Client ID and Secret into `.env`.
2. `npm start`, then choose **Host a game** and create a room.
3. In the lobby, click the PayPal button and log in with a sandbox **Personal** test account. No real money moves.
4. Open the join link in another tab or browser (player sessions are per-tab) and join as a second player.
5. The host starts the investigation once the purchase shows as verified.

### Quick demo without any keys

Choose **Solo demonstration**. It needs no PayPal keys, and without an AI key the witnesses answer in labelled scripted mode.

## Tests

```bash
npm test
```

59 automated tests (Node's built-in test runner) cover: role assignment and room limits; **private clue isolation**; the solution never appearing before reveal; room isolation; host-only actions; accusation rules and immutability; witness prompt isolation (no solution or clue text, no other witness's facts); model-reply validation (bad JSON, invented fact IDs, cross-witness citations); timeouts and provider errors; rate limiting; archive permission filtering and citation validation; and the payment flow against a **simulated** PayPal (success, cancel/abandon, pending, declined, wrong amount, wrong currency, wrong room, forged order id, duplicate/concurrent capture, outage, webhook signature handling). A full game is also played over real HTTP.

### What is and isn't verified

- The payment tests use a simulated PayPal server. The live sandbox calls are written to PayPal's documented v2 Orders API and should be checked with real sandbox credentials before relying on them.
- Live AI mode is tested with simulated model responses. Real model behaviour will vary; the controls below reduce errors but cannot guarantee perfect output.
- The webhook endpoint (signature verification and reconciliation) is implemented and unit-tested against a simulated PayPal, but has not been exercised against real PayPal events.

## How the AI stays consistent

Ordinary code owns the truth (solution, permissions, payments, phases). The model only phrases permitted facts.

1. The authored case file defines the culprit, timeline and clues. It lives server-side.
2. Each witness prompt contains only that witness's fact sheet. The question is placed in the user turn, fenced and marked untrusted.
3. The model must return JSON naming the fact IDs it used. Replies with bad structure, over-long answers, or fact IDs that don't exist for that witness are rejected with a clear error, not shown.
4. Questions are length-limited and rate-limited per player; conversations are stored per player and never shared across players or rooms.
5. If the model is down or slow, the player gets a clear error. Without an API key, answers come from a **scripted** mode that is always labelled as such.

## Architecture

```
Browser (plain JS, no build)  ->  Node HTTP server  ->  SQLite (node:sqlite)
                                      |-> LLM provider (witnesses, archive)
                                      |-> PayPal sandbox (orders, capture, verification, webhook)
```

| File | Role |
|---|---|
| `server/case.js` | Authored case: suspects, roles, clues, witness fact sheets, solution |
| `server/game.js` | Rooms, roles, permissions, phases, sharing, accusation, the *only* builder of what the browser sees |
| `server/witness.js` | Witness prompts, scripted mode, provider calls, validation, rate limiter |
| `server/archive.js` | Permission-filtered keyword retrieval and validated citations |
| `server/paypal.js` | Order creation, capture, server-side verification, idempotent entitlement, webhook |
| `server/app.js` | HTTP routes and static files |
| `server/db.js` | SQLite schema |
| `public/` | The interface |

Player access tokens are random, stored only as SHA-256 hashes, and sent in an `Authorization` header. Room codes help people join; they are not access credentials.

## Limitations

- Not deployed: run locally using the steps above. The in-memory rate limiter and the single SQLite file assume one server process.
- Player sessions live in the browser tab (`sessionStorage`); closing the tab means you can't rejoin that seat.
- State updates by polling every 3 seconds, not websockets.
- One authored adventure; no generated cases, built-in voice chat or embedding-based retrieval.
- Refunds and disputes are not handled; the webhook only reconciles completed captures.
- The scripted witness mode is a keyword matcher for development and fallback, not an AI.

## AI tools used

- **In the game:** an LLM chosen by configuration (default Google AI Studio's Gemini via its OpenAI-compatible API; Anthropic's Messages API is also supported) powers witness answers and the archive summary.
- **In development:** this project was built with AI coding assistance from Claude (Anthropic).

## License

MIT. See [LICENSE](LICENSE).
