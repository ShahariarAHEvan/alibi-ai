import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path = process.env.DB_PATH || "data/alibi.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('solo','multiplayer')),
      phase TEXT NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby','investigation','reveal')),
      purchase_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (purchase_status IN ('unpaid','paid')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      is_host INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT UNIQUE NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (room_id, role)
    );

    CREATE TABLE IF NOT EXISTS shared_evidence (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      clue_id TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES players(id),
      shared_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, clue_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      player_id TEXT NOT NULL REFERENCES players(id),
      witness_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      response_mode TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      owner_player_id TEXT NOT NULL REFERENCES players(id),
      paypal_order_id TEXT UNIQUE NOT NULL,
      paypal_capture_id TEXT UNIQUE,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('created','verified','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accusations (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id),
      suspect TEXT NOT NULL,
      explanation TEXT NOT NULL,
      clue_ids TEXT NOT NULL,
      correct INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
