const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = process.env.COSTWORTH_DB || path.join(__dirname, "..", "data.json");

/**
 * Loads the database from disk. Missing or corrupt files fall back to an
 * empty store rather than crashing the server — a first run has no file yet,
 * and that's a normal state, not an error.
 */
function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

/**
 * Persists the database via write-then-rename, so a crash or concurrent
 * read never observes a half-written file — readers only ever see the
 * previous complete version or the new complete version, never a partial one.
 *
 * Every route handler in server.js calls load(), mutates the result
 * synchronously, and calls save() with no `await` in between. Because
 * Node's fs *Sync calls block the single JS thread for their duration,
 * that load-mutate-save sequence can't be interleaved by another
 * request's handler — which is what keeps concurrent writes from
 * clobbering each other without needing an explicit lock.
 */
function save(db) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** A collision-resistant id, unlike a short Math.random() string. */
function newId() {
  return crypto.randomUUID();
}

module.exports = { load, save, newId };
