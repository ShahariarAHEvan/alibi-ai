import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createGame, GameError } from "../server/game.js";

function setup() {
  const db = openDb(":memory:");
  const game = createGame(db);
  const markPaid = (code) => db.prepare("UPDATE rooms SET purchase_status='paid' WHERE code=?").run(code);
  return { db, game, markPaid };
}

function threePlayerRoom() {
  const { db, game, markPaid } = setup();
  const host = game.createRoom({ name: "Ana", mode: "multiplayer" });
  markPaid(host.code);
  const p2 = game.joinRoom({ code: host.code, name: "Ben" });
  const p3 = game.joinRoom({ code: host.code, name: "Cy" });
  return { db, game, host, p2, p3 };
}

const throwsStatus = (fn, status) =>
  assert.throws(fn, (e) => e instanceof GameError && e.status === status, `expected GameError ${status}`);

test("roles are assigned in join order and room caps at 3", () => {
  const { game, host, p2, p3 } = threePlayerRoom();
  assert.equal(game.getState(host.token).me.role, "systems");
  assert.equal(game.getState(p2.token).me.role, "records");
  assert.equal(game.getState(p3.token).me.role, "field");
  throwsStatus(() => game.joinRoom({ code: host.code, name: "Dee" }), 409);
});

test("no clues visible in lobby", () => {
  const { game, host } = threePlayerRoom();
  const s = game.getState(host.token);
  assert.equal(s.privateClues.length, 0);
  assert.equal(s.room.phase, "lobby");
});

test("multiplayer cannot start unpaid", () => {
  const { game } = setup();
  const host = game.createRoom({ name: "Ana", mode: "multiplayer" });
  game.joinRoom({ code: host.code, name: "Ben" });
  throwsStatus(() => game.startInvestigation(host.token), 402);
});

test("only host can start; private files unlock on start", () => {
  const { game, host, p2 } = threePlayerRoom();
  throwsStatus(() => game.startInvestigation(p2.token), 403);
  const s = game.startInvestigation(host.token);
  assert.equal(s.room.phase, "investigation");
  assert.deepEqual(s.privateClues.map((c) => c.id), ["C1", "C2"]);
});

test("PRIVACY: a player never sees another role's private clues until shared", () => {
  const { game, host, p2, p3 } = threePlayerRoom();
  game.startInvestigation(host.token);
  const ownIds = (t) => game.getState(t).privateClues.map((c) => c.id);
  assert.deepEqual(ownIds(p2.token), ["C3", "C4"]);
  assert.deepEqual(ownIds(p3.token), ["C5", "C6"]);
  // Nothing from other roles appears anywhere in p2's serialised state.
  const json = JSON.stringify(game.getState(p2.token));
  for (const secret of ["Freight reader log", "Recovered courier case", "East gate camera"]) {
    assert.ok(!json.includes(secret), `leaked: ${secret}`);
  }
  // Cannot share a clue you don't own.
  throwsStatus(() => game.shareClue(p2.token, "C1"), 403);
  // After host shares C1, others see it on the board.
  game.shareClue(host.token, "C1");
  const board = game.getState(p2.token).sharedClues;
  assert.deepEqual(board.map((c) => c.id), ["C1"]);
  assert.equal(board[0].sharedBy, "Ana");
  // Sharing twice is idempotent.
  game.shareClue(host.token, "C1");
  assert.equal(game.getState(p2.token).sharedClues.length, 1);
});

test("SOLUTION is never in state before reveal", () => {
  const { game, host } = threePlayerRoom();
  game.startInvestigation(host.token);
  const json = JSON.stringify(game.getState(host.token));
  assert.ok(!json.includes("culprit"));
  assert.ok(!json.includes("evidenceStrength"));
  assert.ok(!json.includes("unauthorized lighting test, triggered it"));
});

test("ROOM ISOLATION: tokens only work for their own room; sharing in one room does not leak", () => {
  const a = threePlayerRoom();
  const b = setup();
  const hostB = b.game.createRoom({ name: "Zed", mode: "multiplayer" });
  b.markPaid(hostB.code);
  b.game.joinRoom({ code: hostB.code, name: "Yu" });
  // Room A token is unknown in game B's DB
  throwsStatus(() => b.game.getState(a.host.token), 401);
  // Within one DB: two rooms, sharing in room 1 doesn't appear in room 2
  const { game } = a;
  const host2 = game.createRoom({ name: "Mia", mode: "multiplayer" });
  a.db.prepare("UPDATE rooms SET purchase_status='paid' WHERE code=?").run(host2.code);
  game.joinRoom({ code: host2.code, name: "Nox" });
  game.startInvestigation(a.host.token);
  game.shareClue(a.host.token, "C2");
  game.startInvestigation(host2.token);
  assert.equal(game.getState(host2.token).sharedClues.length, 0);
});

test("invalid token is rejected", () => {
  const { game } = setup();
  throwsStatus(() => game.getState("nope"), 401);
  throwsStatus(() => game.getState(undefined), 401);
});

test("accusation rules: host only, valid suspect, explanation, available clue", () => {
  const { game, host, p2 } = threePlayerRoom();
  const good = { suspect: "mara", explanation: "F2 is at the freight dock, not the gantry.", clueIds: ["C2"] };
  throwsStatus(() => game.accuse(host.token, good), 409); // lobby
  game.startInvestigation(host.token);
  throwsStatus(() => game.accuse(p2.token, { ...good, clueIds: ["C3"] }), 403); // not host
  throwsStatus(() => game.accuse(host.token, { ...good, suspect: "bob" }), 400);
  throwsStatus(() => game.accuse(host.token, { ...good, explanation: "no" }), 400);
  throwsStatus(() => game.accuse(host.token, { ...good, clueIds: [] }), 400);
  // Host cannot cite a clue that is another role's and unshared.
  throwsStatus(() => game.accuse(host.token, { ...good, clueIds: ["C5"] }), 403);
});

test("correct accusation reveals solution; final result is immutable", () => {
  const { game, host, p2 } = threePlayerRoom();
  game.startInvestigation(host.token);
  game.shareClue(host.token, "C2");
  const s = game.accuse(host.token, {
    suspect: "mara", explanation: "F2 is at the freight dock, not the gantry.", clueIds: ["C2"],
  });
  assert.equal(s.room.phase, "reveal");
  assert.equal(s.reveal.accusation.correct, true);
  assert.equal(s.reveal.culprit, "mara");
  assert.ok(s.reveal.weakEvidenceNote.includes("jacket"));
  // Everyone gets the reveal.
  assert.equal(game.getState(p2.token).reveal.accusation.suspect, "mara");
  // Cannot resubmit or share after reveal.
  throwsStatus(() => game.accuse(host.token, { suspect: "theo", explanation: "Changed my mind okay.", clueIds: ["C2"] }), 409);
  throwsStatus(() => game.shareClue(host.token, "C1"), 409);
});

test("wrong accusation is reported as incorrect", () => {
  const { game, host } = threePlayerRoom();
  game.startInvestigation(host.token);
  const s = game.accuse(host.token, { suspect: "theo", explanation: "He had the ledger access.", clueIds: ["C1"] });
  assert.equal(s.reveal.accusation.correct, false);
  assert.equal(s.reveal.culprit, "mara");
});

test("solo mode: all files visible, labelled, not joinable, free to start", () => {
  const { game } = setup();
  const solo = game.createRoom({ name: "Sam", mode: "solo" });
  throwsStatus(() => game.joinRoom({ code: solo.code, name: "X" }), 403);
  const s = game.startInvestigation(solo.token);
  assert.equal(s.privateClues.length, 6);
  assert.match(s.room.modeLabel, /SOLO DEMONSTRATION/);
  assert.equal(s.room.purchaseStatus, "unpaid");
});

test("input validation: names and unknown rooms", () => {
  const { game } = setup();
  throwsStatus(() => game.createRoom({ name: "   ", mode: "solo" }), 400);
  throwsStatus(() => game.createRoom({ name: "A".repeat(31), mode: "solo" }), 400);
  throwsStatus(() => game.createRoom({ name: "A", mode: "weird" }), 400);
  throwsStatus(() => game.joinRoom({ code: "ZZZZZ", name: "A" }), 404);
});

test("cannot join after investigation starts", () => {
  const { game, host } = threePlayerRoom();
  game.startInvestigation(host.token);
  throwsStatus(() => game.joinRoom({ code: host.code, name: "Late" }), 409);
});
