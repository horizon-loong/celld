// Real-SQL test environment: wires the harness host ops to an in-memory
// SQLite database via node:sqlite, so storage and SqlStorage semantics run
// against a real SQL engine instead of hand-written mocks.
//
// - __sql_cursor_start / __sql_cursor_next / __sql_ingest /
//   __sql_database_size back SqlStorage (real statement execution)
// - __storage_* / __alarm_* / transaction control back DurableObjectStorage
//   through a celld_kv table + SAVEPOINTs (real rollback semantics)
//
// Run with the rest:  node --test crates/celld/js/tests/

import { DatabaseSync } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';
import { makeEnv } from './harness-env.mjs';

function decodeBind(v) {
  if (v !== null && typeof v === 'object' && Array.isArray(v.__celld_bytes))
    return Buffer.from(v.__celld_bytes);
  return v;
}

function rowToColumns(columns, row) {
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
  return out;
}

export function makeSqliteEnv(options = {}) {
  const { scope = 'Counter:test-scope', deleteAllDeletesAlarm = false } = options;
  const env = makeEnv();
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS celld_kv (
    scope TEXT NOT NULL, key TEXT NOT NULL, value BLOB,
    PRIMARY KEY (scope, key))`);
  db.exec(`CREATE TABLE IF NOT EXISTS celld_alarms (
    scope TEXT PRIMARY KEY, time INTEGER NOT NULL)`);

  const s = env.sandbox;
  s.__cell.deleteAllDeletesAlarm = deleteAllDeletesAlarm;
  let cursorSeq = 0;
  let gateSeq = 0;
  let timerSeq = 0;
  const cursors = new Map();
  globalThis.__sqlDebugDump = () =>
    JSON.stringify(db.prepare('SELECT * FROM celld_kv_test').all());

  // --- SqlStorage: real statement execution --------------------------------
  s.__sql_cursor_start = (sc, query, bindsJson) => {
    const binds = JSON.parse(bindsJson).map(decodeBind);
    console.error('[sql-cursor-start] query=', JSON.stringify(query));
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) {
      const rows = stmt.all(...binds).map((o) => {
        const cols = Object.keys(o);
        // node:sqlite returns objects; the cursor wants positional rows.
        return { __row: cols.map((c) => o[c]), __cols: cols };
      });
      const columns = rows.length > 0 ? rows[0].__cols
        : (() => { try { return stmt.columns().map((c) => c.name); } catch { return []; } })();
      const plain = rows.map((r) => r.__row);
      const cursorId = ++cursorSeq;
      // index starts at 1: `row` already returned the first row.
      cursors.set(cursorId, { rows: plain, index: 1 });
      return { columns, rowsWritten: 0, cursorId, row: plain[0] ?? null };
    }
    const result = stmt.run(...binds);
    return { columns: [], rowsWritten: result.changes, cursorId: 0, row: null };
  };
  s.__sql_cursor_next = (cursorId) => {
    const cur = cursors.get(cursorId);
    if (!cur) throw new Error('no such cursor');
    if (cur.index < cur.rows.length) return cur.rows[cur.index++];
    return cur.rows.length;
  };

  // --- DurableObjectStorage: KV over the celld_kv table ---------------------
  s.__storage_get = (sc, key, sent) => {
    const row = db.prepare(
        'SELECT value FROM celld_kv WHERE scope = ? AND key = ?')
        .get(sc, key);
    return row ? [sent, deserialize(row.value)] : [sent];
  };
  s.__storage_get_many = (sc, keys, sent) => {
    const stmt = db.prepare(
        'SELECT key, value FROM celld_kv WHERE scope = ? AND key = ?');
    const found = new Map();
    for (const key of keys) {
      const row = stmt.get(sc, key);
      if (row) found.set(key, [sent, deserialize(row.value)]);
    }
    return [sent, found];
  };
  s.__storage_queue_put = (sc, key, value) => {
    db.prepare('INSERT OR REPLACE INTO celld_kv (scope, key, value) VALUES (?, ?, ?)')
        .run(sc, key, serialize(value));
  };
  s.__storage_queue_put_many = (sc, entries) => {
    const put = db.prepare(
        'INSERT OR REPLACE INTO celld_kv (scope, key, value) VALUES (?, ?, ?)');
    for (const [k, v] of entries) put.run(sc, k, serialize(v));
  };
  s.__storage_flush_pending_puts = () => {};
  s.__storage_put = (sc, key, value) => {
    db.prepare('INSERT OR REPLACE INTO celld_kv (scope, key, value) VALUES (?, ?, ?)')
        .run(sc, key, serialize(value));
  };
  s.__storage_delete = (sc, key) => {
    const r = db.prepare('DELETE FROM celld_kv WHERE scope = ? AND key = ?').run(sc, key);
    return r.changes > 0;
  };
  s.__storage_delete_many = (sc, keys) => {
    const del = db.prepare('DELETE FROM celld_kv WHERE scope = ? AND key = ?');
    let n = 0;
    for (const key of keys) n += del.run(sc, key).changes;
    return n;
  };
  s.__storage_delete_all = (sc) => {
    db.prepare('DELETE FROM celld_kv WHERE scope = ?').run(sc);
    if (deleteAllDeletesAlarm)
      db.prepare('DELETE FROM celld_alarms WHERE scope = ?').run(sc);
  };
  s.__storage_list = (sc, optionsJson, sent) => {
    const o = JSON.parse(optionsJson);
    const where = ['scope = ?'];
    const params = [sc];
    if (o.start !== null && o.start !== undefined) {
      where.push('key >= ?'); params.push(o.start);
    }
    if (o.startAfter !== null && o.startAfter !== undefined) {
      where.push('key > ?'); params.push(o.startAfter);
    }
    if (o.end !== null && o.end !== undefined) {
      where.push('key <= ?'); params.push(o.end);
    }
    if (o.prefix) { where.push(`substr(key, 1, ?) = ?`); params.push(o.prefix.length, o.prefix); }
    const order = o.reverse ? 'DESC' : 'ASC';
    const limit = o.limit > 0 ? ` LIMIT ${o.limit | 0}` : '';
    const rows = db.prepare(
        `SELECT key, value FROM celld_kv WHERE ${where.join(' AND ')} ${order === 'DESC' ? 'ORDER BY key DESC' : 'ORDER BY key'}${limit}`)
        .all(...params);
    const found = new Map();
    for (const row of rows) found.set(row.key, [sent, deserialize(row.value)]);
    return [sent, found];
  };
  s.__storage_sync = () => {};
  s.__storage_sync_list_start = (sc, optionsJson) => {
    const o = JSON.parse(optionsJson);
    const where = ['scope = ?'];
    const params = [sc];
    if (o.prefix) { where.push('substr(key, 1, ?) = ?'); params.push(o.prefix.length, o.prefix); }
    if (o.limit > 0) { where.push(`1 = 1`); }
    const order = 'ASC';
    const limit = o.limit > 0 ? ` LIMIT ${o.limit | 0}` : '';
    const rows = db.prepare(
        `SELECT key, value FROM celld_kv WHERE ${where.join(' AND ')} ORDER BY key ${order}${limit}`)
        .all(...params);
    return { rows: rows.map((r) => [r.key, deserialize(r.value)]) };
  };
  s.__storage_sync_list_next = (cursor) =>
    cursor.rows.length > 0 ? cursor.rows.shift() : null;
  s.__gate_acquire = (sc) => [String(++gateSeq), 'owner', Promise.resolve()];
  s.__gate_release = () => {};

  // --- additional ops -------------------------------------------------------
  s.__sql_ingest = (sc, input) => {
    try { db.exec(input); return JSON.stringify({}); }
    catch (e) { return JSON.stringify({ error: e.message }); }
  };
  s.__sql_database_size = (sc) => {
    const pc = db.prepare('PRAGMA page_count').get();
    const ps = db.prepare('PRAGMA page_size').get();
    return (pc.page_count ?? 0) * (ps.page_size ?? 0);
  };
  s.__storage_cancel_pending_puts = () => 0;
  s.__op_timer = () => new Promise(() => {});

  // --- transactions: real SAVEPOINTs over the same connection ----------------
  s.__storage_transaction_control = (sc, op, nested, savepoint) => {
    if (op === 'start') db.exec(`SAVEPOINT "${savepoint}"`);
    else if (op === 'commit') db.exec(`RELEASE "${savepoint}"`);
    else if (op === 'rollback' || op === 'rollback_explicit') {
      db.exec(`ROLLBACK TO "${savepoint}"`);
      db.exec(`RELEASE "${savepoint}"`);
    }
  };

  // --- alarms ---------------------------------------------------------------
  s.__alarm_set = (sc, t) => {
    db.prepare('INSERT OR REPLACE INTO celld_alarms (scope, time) VALUES (?, ?)')
        .run(sc, t);
  };
  s.__alarm_get = (sc) => {
    const row = db.prepare('SELECT time FROM celld_alarms WHERE scope = ?').get(sc);
    return row ? row.time : null;
  };
  s.__alarm_delete = (sc) => {
    db.prepare('DELETE FROM celld_alarms WHERE scope = ?').run(sc);
  };
  s.__timer_alloc = () => ++timerSeq;
  s.__timer_cancel = () => {};

  env.run(`
    globalThis.__state = new DurableObjectState('${scope}');
    globalThis.__states = globalThis.__states || {};
    globalThis.__states['${scope}'] = __state;
  `);
  env.db = db;
  return env;
}
