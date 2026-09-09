// Compatibility tests for the Durable Objects SDK surface that
// crates/celld/js/harness.js implements: DurableObjectNamespace /
// DurableObjectId / DurableObjectStub identity and routing, and the
// DurableObjectStorage API (get/put/delete/list semantics, alarm
// round-trip, transactionSync nesting) against an in-memory emulation of
// the host storage ops. Each test encodes a behavior documented in the
// Cloudflare Durable Objects SDK.
//
// Run:  node --test crates/celld/js/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness-env.mjs';

// In-memory emulation of the host storage ops the harness calls, with the
// observable semantics of the Rust side: values are stored as tagged rows
// ([sentinel, value]) so the harness's unwrap path sees its own protocol;
// transaction control snapshots and restores the scope map.
function mockStorage(env, { deleteAllDeletesAlarm = false } = {}) {
  // The sentinel is an internal const of the harness script; capture it from
  // inside the context so stored rows carry the exact identity it checks for.
  const sentinel = env.run('__storedSentinel');
  const spaces = new Map(); // scope -> Map<key, [sentinel, value]>
  const alarms = new Map(); // scope -> number
  const snapshots = new Map(); // savepoint -> Map
  const space = (scope) => {
    let m = spaces.get(scope);
    if (!m) spaces.set(scope, (m = new Map()));
    return m;
  };
  const s = env.sandbox;
  s.__storage_get = (scope, key, sent) => {
    const m = spaces.get(scope);
    return m && m.has(key) ? m.get(key) : [sent];
  };
  s.__storage_get_many = (scope, keys, sent) => {
    const m = spaces.get(scope) ?? new Map();
    const found = new Map();
    for (const k of keys) if (m.has(k)) found.set(k, m.get(k));
    return [sent, found];
  };
  s.__storage_queue_put = (scope, key, value) => {
    space(scope).set(key, [sentinel, value]);
  };
  s.__storage_queue_put_many = (scope, entries) => {
    const m = space(scope);
    for (const [k, v] of entries) m.set(k, [sentinel, v]);
  };
  s.__storage_flush_pending_puts = () => {};
  s.__storage_delete = (scope, key) => {
    const m = spaces.get(scope);
    return m ? m.delete(key) : false;
  };
  s.__storage_delete_many = (scope, keys) => {
    const m = spaces.get(scope);
    let n = 0;
    for (const k of keys) if (m.delete(k)) n++;
    return n;
  };
  s.__storage_delete_all = (scope) => {
    spaces.set(scope, new Map());
    if (deleteAllDeletesAlarm) alarms.delete(scope);
  };
  s.__storage_list = (scope, optionsJson, sent) => {
    const o = JSON.parse(optionsJson);
    const m = spaces.get(scope) ?? new Map();
    let rows = [...m.entries()]
        .map(([k, v]) => [k, v]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (o.start !== null && o.start !== undefined)
      rows = rows.filter(([k]) => k >= o.start);
    if (o.startAfter !== null && o.startAfter !== undefined)
      rows = rows.filter(([k]) => k > o.startAfter);
    if (o.end !== null && o.end !== undefined)
      rows = rows.filter(([k]) => k <= o.end);
    if (o.prefix) rows = rows.filter(([k]) => k.startsWith(o.prefix));
    if (o.reverse) rows.reverse();
    if (o.limit > 0) rows = rows.slice(0, o.limit);
    const found = new Map(rows);
    return [sent, found];
  };
  s.__storage_sync = () => {};
  s.__storage_transaction_control = (scope, op, nested, savepoint) => {
    if (op === 'start') snapshots.set(savepoint, new Map(space(scope)));
    else if (op === 'commit') snapshots.delete(savepoint);
    else if (op === 'rollback' || op === 'rollback_explicit') {
      const snap = snapshots.get(savepoint);
      if (snap) spaces.set(scope, new Map(snap));
      snapshots.delete(savepoint);
    }
  };
  s.__alarm_set = (scope, t) => alarms.set(scope, t);
  s.__alarm_get = (scope) => (alarms.has(scope) ? alarms.get(scope) : null);
  s.__alarm_delete = (scope) => alarms.delete(scope);
  // The harness asks the flag at load: rebuild storage mocks after deploy.
  s.__cell.deleteAllDeletesAlarm = deleteAllDeletesAlarm;
  return {
    alarm: (scope) => alarms.get(scope),
    keys: (scope) => [...(spaces.get(scope)?.keys() ?? [])],
  };
}

function deployCounter(env) {
  env.run(`
    globalThis.__cell.entrypoints.Counter = class Counter {
      async increment(n) { return n + 1; }
    };
    __cell.namespaceKeys.Counter = 'counter-key';
  `);
}

// --- DurableObjectNamespace / DurableObjectId --------------------------------

test('idFromName is deterministic; ids from the same name are equal', () => {
  const env = makeEnv();
  deployCounter(env);
  const out = env.run(`(() => {
    let seq = 0;
    const hex = (n) => {
      let out = '';
      for (let i = 0; i < 64; i++) out += ((n >> i) & 1 ? 'b' : 'a');
      return out;
    };
    __do_id = (ns, kind, name) => hex(name.length + seq);
    const ns = __cell.makeNamespace('Counter');
    const a = ns.idFromName('alice');
    const b = ns.idFromName('alice');
    const c = ns.idFromName('bob');
    return {
      same: a.equals(b),
      different: !a.equals(c),
      hex64: /^[0-9a-f]+$/.test(a.toString()) && a.toString().length > 0,
    };
  })()`);
  assert.equal(out.same, true);
  assert.equal(out.different, true);
  assert.equal(out.hex64, true);
});

test('newUniqueId returns unique ids and jurisdiction is refused', () => {
  const env = makeEnv();
  deployCounter(env);
  const out = env.run(`(() => {
    let seq = 0;
    __do_id = (ns, kind, name) =>
      kind === 'unique' ? ns + ':unique-' + (++seq) : (name || ns + ':' + kind);
    const ns = __cell.makeNamespace('Counter');
    const a = ns.newUniqueId();
    const b = ns.newUniqueId();
    let jurisdictionError = null;
    try { ns.newUniqueId({ jurisdiction: 'eu' }); }
    catch (e) { jurisdictionError = /jurisdiction|not implemented/i.test(e.message); }
    return { unique: !a.equals(b), jurisdictionError };
  })()`);
  assert.equal(out.unique, true);
  assert.equal(out.jurisdictionError, true);
});

test('idFromString rejects non-id strings like workerd', () => {
  const env = makeEnv();
  deployCounter(env);
  const out = env.run(`(() => {
    // Mirror the host contract: only minted 64-hex ids validate; anything
    // else is a TypeError with workerd's message.
    const valid = new Set();
    const hex = (n) => {
      let out = '';
      for (let i = 0; i < 64; i++) out += ((n >> i) & 1 ? 'b' : 'a');
      return out;
    };
    __do_id = (ns, kind, input) => {
      if (kind === 'name') return hex(input.length);
      if (kind === 'unique') return hex(63);
      if (/^[0-9a-f]{64}$/.test(input) && valid.has(input)) return input;
      throw new TypeError('Invalid Durable Object ID: must be 64 hex digits');
    };
    const ns = __cell.makeNamespace('Counter');
    const minted = ns.idFromName('alice').toString();
    valid.add(minted);
    const results = {};
    try { ns.idFromString(minted); results.validOk = true; }
    catch { results.validOk = false; }
    try { ns.idFromString('not-an-id'); results.garbageRefused = true; }
    catch (e) { results.garbageRefused = /Invalid Durable Object ID/.test(e.message); }
    return results;
  })()`);
  assert.equal(out.validOk, true);
  assert.equal(out.garbageRefused, true);
});

test('namespace.get refuses ids from another namespace; stub carries id and name', () => {
  const env = makeEnv();
  deployCounter(env);
  const out = env.run(`(() => {
    __cell.namespaceKeys.Counter = 'counter-key';
    __cell.namespaceKeys.Other = 'other-key';
    __do_id = (ns, kind, name) => ns + ':' + kind + ':' + (name || 'x');
    const counter = __cell.makeNamespace('Counter');
    const other = __cell.makeNamespace('Other');
    const foreign = other.get(other.idFromName('w1'));
    const results = {};
    try { counter.get(foreign.id); results.foreignRefused = true; }
    catch (e) { results.foreignRefused = /not valid for this namespace/.test(e.message); }
    const mine = counter.get(counter.idFromName('alice'));
    results.stubIdMatches = mine.id.equals(counter.idFromName('alice'));
    results.stubName = mine.name;
    return results;
  })()`);
  assert.equal(out.foreignRefused, true);
  assert.equal(out.stubIdMatches, true);
  assert.equal(out.stubName, 'alice');
});

// --- DurableObjectStorage ------------------------------------------------------

function storageTestSetup(env, options = {}) {
  const memory = mockStorage(env, options);
  env.run(`globalThis.__state = new DurableObjectState('Counter:test-scope');`);
  return memory;
}

test('storage: put/get round-trips values and misses return undefined', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      await s.put('greeting', { text: 'hello' });
      await s.put('count', 7);
      return {
        greeting: await s.get('greeting'),
        count: await s.get('count'),
        missing: await s.get('absent'),
      };
    })()
  `);
  assert.equal(JSON.stringify(out.greeting), JSON.stringify({ text: 'hello' }));
  assert.equal(out.count, 7);
  assert.equal(out.missing, undefined);
});

test('storage: delete reports existence and deleteAll clears', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      await s.put('a', 1);
      await s.put('b', 2);
      const existed = await s.delete('a');
      const goneTwice = await s.delete('a');
      const remaining = [...(await s.list()).keys()];
      await s.deleteAll();
      const afterAll = await s.get('b');
      return { existed, goneTwice, remaining, afterAll };
    })()
  `);
  assert.equal(out.existed, true);
  assert.equal(out.goneTwice, false);
  assert.equal(JSON.stringify(out.remaining.sort()), JSON.stringify(['b']));
  assert.equal(out.afterAll, undefined);
});

test('storage: list orders lexicographically with prefix, startAfter and limit', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      // Insert deliberately out of lexicographic order.
      await s.put('user:carol', 3);
      await s.put('config', 0);
      await s.put('user:alice', 1);
      await s.put('user:bob', 2);
      const all = [...(await s.list()).keys()];
      const users = [...(await s.list({ prefix: 'user:' })).keys()];
      const paged = [...(await s.list({ prefix: 'user:', limit: 2 })).keys()];
      const after = [...(await s.list({ startAfter: 'user:alice' })).keys()];
      return { all, users, paged, after };
    })()
  `);
  const j = (v) => JSON.stringify(v);
  assert.equal(j(out.all), j(['config', 'user:alice', 'user:bob', 'user:carol']));
  assert.equal(j(out.users), j(['user:alice', 'user:bob', 'user:carol']));
  assert.equal(j(out.paged), j(['user:alice', 'user:bob']));
  assert.equal(j(out.after), j(['user:bob', 'user:carol']));
});

test('storage: alarms round-trip as timestamps', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      const none = await s.getAlarm();
      const at = Date.now() + 60_000;
      await s.setAlarm(at);
      const read = await s.getAlarm();
      await s.deleteAlarm();
      const cleared = await s.getAlarm();
      return { none, read, cleared };
    })()
  `);
  assert.equal(out.none, null);
  assert.equal(out.read, out.read); // present
  assert.ok(typeof out.read === 'number');
  assert.equal(out.cleared, null);
});

test('storage: transactionSync rolls back on throw and nests with savepoints', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      await s.put('k', 'initial');

      // A throwing transaction reverts its writes.
      try {
        await s.transactionSync(() => {
          s.put('k', 'rolled-back');
          s.put('extra', 'x');
          throw new Error('boom');
        });
      } catch (e) { /* expected */ }
      const afterRollback = await s.get('k');
      const extraAfterRollback = await s.get('extra');

      // A committed transaction persists, including nested sync storage.
      await s.transactionSync(() => {
        s.put('k', 'committed');
        s.transactionSync(() => { s.put('nested', 'yes'); });
      });
      return {
        afterRollback,
        extraAfterRollback: extraAfterRollback ?? null,
        committed: await s.get('k'),
        nested: await s.get('nested'),
      };
    })()
  `);
  assert.equal(out.afterRollback, 'initial');
  assert.equal(out.extraAfterRollback, null);
  assert.equal(out.committed, 'committed');
  assert.equal(out.nested, 'yes');
});

test('storage: transactionSync passes the callback value through; writes after the boundary are outside', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      const returned = s.transactionSync(() => {
        s.put('inside', 'yes');
        return 'callback-value';
      });
      // A write that lands after the boundary belongs to no transaction.
      s.put('outside', 'also-yes');
      return {
        returned,
        inside: await s.get('inside'),
        outside: await s.get('outside'),
      };
    })()
  `);
  assert.equal(out.returned, 'callback-value');
  assert.equal(out.inside, 'yes');
  assert.equal(out.outside, 'also-yes');
});

test('storage: async transaction rolls back when the callback throws', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  const out = await env.run(`
    (async () => {
      const s = __state.storage;
      try {
        await s.transaction(async () => {
          await s.put('doomed', 'value');
          throw new Error('abort the transaction');
        });
      } catch (e) { /* expected */ }
      return { doomed: (await s.get('doomed')) ?? null };
    })()
  `);
  assert.equal(out.doomed, null);
});
