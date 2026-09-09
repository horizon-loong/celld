// Compatibility tests for the Durable Objects storage and SQL surfaces,
// executed against a REAL SQLite engine (node:sqlite) through the harness:
// DurableObjectStorage get/put/list/delete/alarm/transaction semantics and
// SqlStorage exec/prepare/ingest/databaseSize run actual SQL statements.
//
// Run:  node --test crates/celld/js/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness-env.mjs';
import { makeSqliteEnv } from './sqlite-env.mjs';

const j = (v) => JSON.stringify(v);

function sqlTest(name, fn) {
  test(name, async () => {
    const env = makeSqliteEnv({ scope: 'Counter:test' });
    env.run(`
      __cell.namespaceKeys.Counter = 'counter-key';
      __cell.classes.Counter = class Counter extends __cf.DurableObject {};
    `);
    await fn(env);
  });
}

// --- DurableObjectStorage over real SQL --------------------------------------

sqlTest('storage put/get round-trips values', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put('obj', { hello: 'world', n: 42 });
    await s.put('num', 7);
    await s.put('str', 'text');
    return {
      obj: await s.get('obj'),
      num: await s.get('num'),
      str: await s.get('str'),
      missing: await s.get('absent'),
    };
  })()`);
  assert.equal(j(JSON.parse(JSON.stringify(out.obj))), j({ hello: 'world', n: 42 }));
  assert.equal(out.num, 7);
  assert.equal(out.str, 'text');
  assert.equal(out.missing, undefined);
});

sqlTest('storage.list orders lexicographically with prefix/startAfter/limit/reverse', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put('user:carol', 3);
    await s.put('config', 0);
    await s.put('user:alice', 1);
    await s.put('user:bob', 2);
    const all = [...(await s.list()).keys()];
    const users = [...(await s.list({ prefix: 'user:' })).keys()];
    const paged = [...(await s.list({ prefix: 'user:', limit: 2 })).keys()];
    const after = [...(await s.list({ startAfter: 'user:alice' })).keys()];
    const reversed = [...(await s.list({ prefix: 'user:', reverse: true })).keys()];
    return { all, users, paged, after, reversed };
  })()`);
  assert.equal(j(JSON.parse(JSON.stringify(out.all))), j(['config', 'user:alice', 'user:bob', 'user:carol']));
  assert.equal(j(JSON.parse(JSON.stringify(out.users))), j(['user:alice', 'user:bob', 'user:carol']));
  assert.equal(j(JSON.parse(JSON.stringify(out.paged))), j(['user:alice', 'user:bob']));
  assert.deepEqual(JSON.parse(JSON.stringify(out.after)), ['user:bob', 'user:carol']);
  assert.equal(j(JSON.parse(JSON.stringify(out.reversed))), j(['user:carol', 'user:bob', 'user:alice']));
});

sqlTest('storage.delete reports existence; deleteAll clears everything', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put('a', 1);
    await s.put('b', 2);
    const existed = await s.delete('a');
    const goneTwice = await s.delete('a');
    const left = [...(await s.list()).keys()];
    await s.deleteAll();
    return { existed, goneTwice, left, afterAll: (await s.get('b')) ?? null };
  })()`);
  assert.equal(out.existed, true);
  assert.equal(out.goneTwice, false);
  assert.equal(j(JSON.parse(JSON.stringify(out.left))), j(['b']));
  assert.equal(out.afterAll, null);
});

sqlTest('storage batch forms: object put, array get, array delete count', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put({ x: 1, y: 2, z: 3 });
    const got = await s.get(['x', 'z', 'absent']);
    const deleted = await s.delete(['x', 'absent']);
    return { mapX: got.get('x'), mapZ: got.get('z'),
             mapAbsent: got.get('absent'), deleted };
  })()`);
  assert.equal(out.mapX, 1);
  assert.equal(out.mapZ, 3);
  assert.equal(out.mapAbsent, undefined);
  assert.equal(out.deleted, 1);
});

sqlTest('transactionSync commits on success', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.transactionSync(() => { s.put('tx', 'committed'); });
    return await s.get('tx');
  })()`);
  assert.equal(out, 'committed');
});

sqlTest('transactionSync rolls back on throw', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put('keep', 'survives');
    let threw = null;
    try {
      await s.transactionSync(() => {
        s.put('transient', 'x');
        throw new Error('boom');
      });
    } catch (e) { threw = e.message; }
    return { threw, transient: (await s.get('transient')) ?? null,
             keep: await s.get('keep') };
  })()`);
  assert.match(out.threw, /boom/);
  assert.equal(out.transient, null);
  assert.equal(out.keep, 'survives');
});

sqlTest('nested transactionSync: inner rollback reverts only the inner write', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    await s.put('outer', 'v1');
    try {
      await s.transactionSync(() => {
        s.put('inner', 'attempted');
        throw new Error('inner rollback');
      });
    } catch (e) { /* expected */ }
    return { inner: (await s.get('inner')) ?? null, outer: (await s.get('outer')) ?? null };
  })()`);
  assert.equal(out.inner, null);
  assert.equal(out.outer, 'v1');
});

// --- alarms ------------------------------------------------------------------

sqlTest('alarm round-trip through real storage', async (env) => {
  const out = await env.run(`(async () => {
    const s = __state.storage;
    const none = await s.getAlarm();
    const at = Date.now() + 60_000;
    await s.setAlarm(at);
    const read = await s.getAlarm();
    await s.deleteAlarm();
    const cleared = await s.getAlarm();
    return { none, read, cleared, at };
  })()`);
  assert.equal(out.none, null);
  assert.equal(out.read, out.at);
  assert.equal(out.cleared, null);
});

// --- SqlStorage: real execution ----------------------------------------------

sqlTest('sql exec creates, inserts, and selects through real SQLite', async (env) => {
  const out = await env.run(`(async () => {
    const sql = __state.storage.sql;
    sql.exec('CREATE TABLE users (id INTEGER, name TEXT)');
    sql.exec('INSERT INTO users VALUES (?, ?)', 1, 'a');
    const cursor = sql.exec('SELECT id, name FROM users ORDER BY id');
    const rows = [];
    for (const row of cursor) rows.push(row);
    return { rows, columns: cursor.columns, rowsWritten: cursor.rowsWritten };
  })()`);
  console.error('[sql-debug]', JSON.stringify(out));
  assert.equal(j(JSON.parse(JSON.stringify(out.rows))), j([
    { id: 1, name: 'a' },
  ]));
  assert.equal(j(out.columns), j(['id', 'name']));
});

sqlTest('sql prepare returns a reusable statement', async (env) => {
  const out = await env.run(`(async () => {
    const sql = __state.storage.sql;
    sql.exec('CREATE TABLE t (n INTEGER)');
    sql.exec('INSERT INTO t VALUES (11)');
    const query = sql.prepare('SELECT n FROM t ORDER BY n');
    const first = [...query()].map((r) => r.n);
    sql.exec('INSERT INTO t VALUES (22)');
    const second = [...query()].map((r) => r.n);
    return { first, second };
  })()`);
  assert.equal(j(out.first), j([11]));
  assert.equal(j(out.second), j([11, 22]));
});

sqlTest('sql binds accept ArrayBuffer and typed arrays as blobs', async (env) => {
  const out = await env.run(`(async () => {
    const sql = __state.storage.sql;
    sql.exec('CREATE TABLE blobs (id INTEGER, data BLOB)');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    sql.exec('INSERT INTO blobs VALUES (?, ?)', 1, bytes);
    const cursor = sql.exec('SELECT data FROM blobs');
    const row = [...cursor][0];
    const view = new Uint8Array(row.data);
    return Array.from(view);
  })()`);
  assert.equal(j(out), j([1, 2, 3, 4]));
});

sqlTest('sql ingest runs a multi-statement script', async (env) => {
  const out = await env.run(`(async () => {
    const sql = __state.storage.sql;
    sql.ingest('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (5); INSERT INTO t VALUES (6);');
    const cursor = sql.exec('SELECT n FROM t ORDER BY n');
    return [...cursor].map((r) => r.n);
  })()`);
  assert.equal(j(out), j([5, 6]));
});

sqlTest('sql databaseSize is positive after writes', async (env) => {
  const size = await env.run(`(async () => {
    const sql = __state.storage.sql;
    sql.exec('CREATE TABLE t (n INTEGER)');
    sql.exec('INSERT INTO t VALUES (1)');
    return sql.databaseSize;
  })()`);
  assert.ok(size > 0);
});

// --- state ---------------------------------------------------------------------

sqlTest('state.abort marks aborted and storage refuses SQL afterwards', async (env) => {
  const out = await env.run(`(async () => {
    const state = new DurableObjectState('Counter:ab');
    state.abort('shutting down');
    let refused = null;
    try { state.storage.sql.exec('SELECT 1'); }
    catch (e) { refused = /was reset|storage is closed/.test(e.message); }
    return { aborted: state._aborted, refused };
  })()`);
  assert.equal(out.aborted, true);
  assert.equal(out.refused, true);
});

sqlTest('blockConcurrencyWhile runs, propagates errors, and drains nested blocks', async (env) => {
  const out = await env.run(`(async () => {
    const state = new DurableObjectState('Counter:bc');
    const ran = await state.blockConcurrencyWhile(() => 'ran');
    let nestedError = null;
    try {
      await state.blockConcurrencyWhile(() => {
        return state.blockConcurrencyWhile(() => { throw new Error('inner fail'); });
      });
    } catch (e) { nestedError = e.message; }
    return { ran, nestedError };
  })()`);
  assert.equal(out.ran, 'ran');
  assert.match(out.nestedError, /inner fail/);
});

sqlTest('state.waitUntil registers background work with the host', async (env) => {
  const waited = [];
  env.sandbox.__wait_until = (promise) => waited.push(promise);
  await env.run(`__state.waitUntil(Promise.resolve('x'))`);
  assert.equal(waited.length, 1);
});

// --- storage.kv (sync KV surface) -----------------------------------------------

sqlTest('storage.kv sync round-trip and list ordering', async (env) => {
  const out = await env.run(`(async () => {
    const kv = __state.storage.kv;
    kv.put('b', 2); kv.put('a', 1); kv.put('c', 3);
    const keys = [...kv.list({ prefix: '' })].map(([k]) => k);
    const values = [...kv.list()].map(([k, v]) => [k, v]);
    kv.delete('b');
    const after = [...kv.list()].map(([k]) => k);
    return { keys, values, after };
  })()`);
  assert.equal(j(out.keys), j(['a', 'b', 'c']));
  assert.equal(j(out.values), j([['a', 1], ['b', 2], ['c', 3]]));
  assert.equal(j(out.after), j(['a', 'c']));
});
