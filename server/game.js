import { randomBytes, createHash, randomUUID } from "node:crypto";
import {
  CASE_INFO, SUSPECTS, ROLES, ROLE_ORDER, CLUES, CLUE_BY_ID, SOLUTION,
} from "./case.js";

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_PLAYERS = 3;

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

function cleanName(name) {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 30) throw new GameError("Name must be 1-30 characters.");
  return n;
}

export function createGame(db) {
  const q = {
    roomByCode: db.prepare("SELECT * FROM rooms WHERE code = ?"),
    roomById: db.prepare("SELECT * FROM rooms WHERE id = ?"),
    playerByToken: db.prepare("SELECT * FROM players WHERE token_hash = ?"),
    playersInRoom: db.prepare("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at, rowid"),
    sharedInRoom: db.prepare("SELECT * FROM shared_evidence WHERE room_id = ? ORDER BY shared_at, rowid"),
    accusation: db.prepare("SELECT * FROM accusations WHERE room_id = ?"),
    messagesFor: db.prepare(
      "SELECT id, witness_id, question, answer, source_ids, response_mode, created_at FROM messages WHERE room_id = ? AND player_id = ? ORDER BY id"
    ),
  };

  function newCode() {
    for (let i = 0; i < 20; i++) {
      let code = "";
      const bytes = randomBytes(5);
      for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!q.roomByCode.get(code)) return code;
    }
    throw new GameError("Could not allocate a room code.", 500);
  }

  function addPlayer(roomId, name, role, isHost) {
    const token = randomBytes(32).toString("hex");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO players (id, room_id, name, role, is_host, token_hash) VALUES (?,?,?,?,?,?)"
    ).run(id, roomId, name, role, isHost ? 1 : 0, hashToken(token));
    return { id, token };
  }

  /** mode: 'solo' (free demonstration, all files visible) or 'multiplayer' (needs purchase). */
  function createRoom({ name, mode }) {
    name = cleanName(name);
    if (mode !== "solo" && mode !== "multiplayer") throw new GameError("Mode must be 'solo' or 'multiplayer'.");
    const id = randomUUID();
    const code = newCode();
    db.prepare("INSERT INTO rooms (id, code, mode) VALUES (?,?,?)").run(id, code, mode);
    const role = mode === "solo" ? "systems" : ROLE_ORDER[0];
    const { token } = addPlayer(id, name, role, true);
    return { code, token };
  }

  function joinRoom({ code, name }) {
    name = cleanName(name);
    const room = q.roomByCode.get(String(code ?? "").trim().toUpperCase());
    if (!room) throw new GameError("Room not found.", 404);
    if (room.mode === "solo") throw new GameError("That room is a solo demonstration and cannot be joined.", 403);
    if (room.phase !== "lobby") throw new GameError("The investigation has already started.", 409);
    // Serialise the capacity check + insert so simultaneous joins cannot overfill.
    db.exec("BEGIN IMMEDIATE");
    try {
      const members = q.playersInRoom.all(room.id);
      if (members.length >= MAX_PLAYERS) throw new GameError("Room is full.", 409);
      const taken = new Set(members.map((m) => m.role));
      const role = ROLE_ORDER.find((r) => !taken.has(r));
      const { token } = addPlayer(room.id, name, role, false);
      db.exec("COMMIT");
      return { code: room.code, token };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  function authenticate(token) {
    if (!token || typeof token !== "string") throw new GameError("Missing access token.", 401);
    const player = q.playerByToken.get(hashToken(token));
    if (!player) throw new GameError("Invalid or expired access token.", 401);
    const room = q.roomById.get(player.room_id);
    return { player, room };
  }

  /** Clue IDs this player may see right now. Private = own role (all roles in solo). Plus shared. */
  function visibleClueIds(player, room) {
    if (room.phase === "lobby") return new Set();
    const ids = new Set();
    if (room.mode === "solo") CLUES.forEach((c) => ids.add(c.id));
    else ROLES[player.role].clueIds.forEach((id) => ids.add(id));
    q.sharedInRoom.all(room.id).forEach((s) => ids.add(s.clue_id));
    return ids;
  }

  function startInvestigation(token) {
    const { player, room } = authenticate(token);
    if (!player.is_host) throw new GameError("Only the host can start the investigation.", 403);
    if (room.phase !== "lobby") throw new GameError("Investigation already started.", 409);
    if (room.mode === "multiplayer") {
      if (room.purchase_status !== "paid") throw new GameError("This adventure has not been purchased yet.", 402);
      if (q.playersInRoom.all(room.id).length < 2)
        throw new GameError("At least 2 players are needed to start (3 recommended).", 409);
    }
    db.prepare("UPDATE rooms SET phase = 'investigation' WHERE id = ?").run(room.id);
    return getState(token);
  }

  function shareClue(token, clueId) {
    const { player, room } = authenticate(token);
    if (room.phase !== "investigation") throw new GameError("Clues can only be shared during the investigation.", 409);
    const clue = CLUE_BY_ID[clueId];
    if (!clue) throw new GameError("Unknown clue.", 404);
    const owns = room.mode === "solo" || clue.ownerRole === player.role;
    if (!owns) throw new GameError("You can only share your own private clues.", 403);
    db.prepare("INSERT OR IGNORE INTO shared_evidence (room_id, clue_id, player_id) VALUES (?,?,?)")
      .run(room.id, clueId, player.id);
    return getState(token);
  }

  function accuse(token, { suspect, explanation, clueIds }) {
    const { player, room } = authenticate(token);
    if (!player.is_host) throw new GameError("Only the host can submit the accusation.", 403);
    if (room.phase !== "investigation") throw new GameError("The accusation can only be submitted during the investigation.", 409);
    if (!SUSPECTS.some((s) => s.id === suspect)) throw new GameError("Choose one of the listed suspects.");
    explanation = String(explanation ?? "").trim();
    if (explanation.length < 10 || explanation.length > 1500)
      throw new GameError("Explain your reasoning (10-1500 characters).");
    if (!Array.isArray(clueIds) || clueIds.length < 1) throw new GameError("Select at least one clue.");
    const visible = visibleClueIds(player, room);
    const unique = [...new Set(clueIds)];
    if (!unique.every((id) => visible.has(id)))
      throw new GameError("You can only cite clues that are available to the group.", 403);

    const correct = suspect === SOLUTION.culprit ? 1 : 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const fresh = q.roomById.get(room.id);
      if (fresh.phase !== "investigation") throw new GameError("Accusation already submitted.", 409);
      db.prepare(
        "INSERT INTO accusations (room_id, suspect, explanation, clue_ids, correct) VALUES (?,?,?,?,?)"
      ).run(room.id, suspect, explanation, JSON.stringify(unique), correct);
      db.prepare("UPDATE rooms SET phase = 'reveal' WHERE id = ?").run(room.id);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
    return getState(token);
  }

  function publicClue(c) {
    return { id: c.id, title: c.title, sourceType: c.sourceType, timestamp: c.timestamp, ownerRole: c.ownerRole, text: c.text };
  }

  /** The ONLY function that builds what the browser sees. Solution is added only in reveal phase. */
  function getState(token) {
    const { player, room } = authenticate(token);
    const members = q.playersInRoom.all(room.id);
    const visible = visibleClueIds(player, room);
    const shared = q.sharedInRoom.all(room.id);
    const sharedIds = new Set(shared.map((s) => s.clue_id));
    const nameById = Object.fromEntries(members.map((m) => [m.id, m.name]));

    const privateClues = [];
    if (room.phase !== "lobby") {
      const own = room.mode === "solo" ? CLUES : CLUES.filter((c) => c.ownerRole === player.role);
      for (const c of own) privateClues.push({ ...publicClue(c), shared: sharedIds.has(c.id) });
    }

    const state = {
      case: CASE_INFO,
      suspects: SUSPECTS,
      room: {
        code: room.code,
        mode: room.mode,
        modeLabel: room.mode === "solo" ? "SOLO DEMONSTRATION MODE (all files visible, free)" : "Purchased multiplayer session",
        phase: room.phase,
        purchaseStatus: room.purchase_status,
        maxPlayers: MAX_PLAYERS,
      },
      me: {
        id: player.id,
        name: player.name,
        isHost: !!player.is_host,
        role: ROLES[player.role].id,
        roleTitle: ROLES[player.role].title,
        intro: ROLES[player.role].intro,
      },
      members: members.map((m) => ({
        name: m.name, roleTitle: ROLES[m.role].title, isHost: !!m.is_host, isYou: m.id === player.id,
      })),
      privateClues,
      sharedClues: shared
        .filter((s) => visible.has(s.clue_id))
        .map((s) => ({ ...publicClue(CLUE_BY_ID[s.clue_id]), sharedBy: nameById[s.player_id] || "?" })),
      messages: q.messagesFor.all(room.id, player.id).map((m) => ({
        id: m.id, witnessId: m.witness_id, question: m.question, answer: m.answer,
        sourceIds: JSON.parse(m.source_ids), responseMode: m.response_mode, createdAt: m.created_at,
      })),
    };

    if (room.phase === "reveal") {
      const acc = q.accusation.get(room.id);
      const accClues = JSON.parse(acc.clue_ids);
      state.reveal = {
        accusation: { suspect: acc.suspect, explanation: acc.explanation, clueIds: accClues, correct: !!acc.correct },
        culprit: SOLUTION.culprit,
        summary: SOLUTION.summary,
        timeline: SOLUTION.timeline,
        evidenceStrength: SOLUTION.evidenceStrength.map((e) => ({ ...e, title: CLUE_BY_ID[e.clueId].title })),
        weakEvidenceNote: SOLUTION.weakEvidenceNote,
        // Reveal exposes the whole case file to everyone once the accusation is final.
        allClues: CLUES.map(publicClue),
      };
    }
    return state;
  }

  /** Witness interviews are only allowed during the investigation phase. */
  function requireInvestigation(token) {
    const { player, room } = authenticate(token);
    if (room.phase !== "investigation") throw new GameError("Witnesses can only be questioned during the investigation.", 409);
    return { player, room };
  }

  /** Last few exchanges between THIS player and THIS witness (conversations are never shared across players). */
  function recentExchanges(playerId, roomId, witnessId, limit = 4) {
    const rows = db.prepare(
      "SELECT question, answer FROM messages WHERE room_id = ? AND player_id = ? AND witness_id = ? ORDER BY id DESC LIMIT ?"
    ).all(roomId, playerId, witnessId, limit);
    return rows.reverse();
  }

  function saveMessage({ roomId, playerId, witnessId, question, answer, sourceIds, responseMode }) {
    db.prepare(
      "INSERT INTO messages (room_id, player_id, witness_id, question, answer, source_ids, response_mode) VALUES (?,?,?,?,?,?,?)"
    ).run(roomId, playerId, witnessId, question, answer, JSON.stringify(sourceIds), responseMode);
  }

  return {
    createRoom, joinRoom, authenticate, startInvestigation, shareClue, accuse, getState,
    visibleClueIds, requireInvestigation, recentExchanges, saveMessage, MAX_PLAYERS,
  };
}
