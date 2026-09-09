// Compatibility tests for celld's host->JS delivery seams and the
// cross-isolate stub bridge — the parts of the DO SDK that a pure object
// model cannot cover: alarm firing, hibernatable WebSocket delivery,
// the DO RPC receiver, and bridged ops from a foreign isolate.
//
// The seams mirror workerd's delivery points: the host calls
// __fireAlarm / __wsMessage / __wsClosed / __dispatchRpc into the isolate;
// app code sees them as alarm()/webSocketMessage()/webSocketClose() and
// stub method calls. Per the compat doc, app code must run unchanged.
//
// Run:  node --test crates/celld/js/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, storageTestSetup } from './harness-env.mjs';

function deployCounterClass(env, calls) {
  env.run(`
    __cell.classes.Counter = class Counter extends __cf.DurableObject {
      constructor(state, env) { super(state, env); this.calls = calls; }
      async increment(n) { this.calls.push(['increment', n]); return n + 1; }
    };
    __cell.compat.jsRpc = true;
  `);
}

// --- DO RPC receiver ----------------------------------------------------------

test('__dispatchRpc decodes to the method result', async () => {
  const env = makeEnv();
  const calls = [];
  env.sandbox.__calls = calls;
  env.run(`
    __cell.classes.Counter = class Counter extends __cf.DurableObject {
      async increment(n) { __calls.push(['increment', n]); return n + 1; }
    };
    __cell.compat.jsRpc = true;
  `);
  const reply = await env.run(
      `__dispatchRpc('Counter:obj1', 'increment', __rpcOut([5], true))`);
  const value = env.run(`__rpcDes(new Uint8Array([${new Uint8Array(reply).join(',')}]))`);
  assert.equal(value, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['increment', 5]]);
});

// --- Cross-isolate stub bridge --------------------------------------------------

test('a stub bridged from a foreign isolate runs against the owning target', async () => {
  // Isolate A owns the target; isolate B revives the marker and calls.
  const envA = makeEnv();
  const calls = [];
  envA.sandbox.__calls = calls;
  envA.run(`
    __cell.classes.Counter = class Counter extends __cf.DurableObject {
      increment(n) { __calls.push(['increment', n]); return n + 1; }
    };
    __cell.compat.jsRpc = true;
    // The target object lives in isolate A; mint a stub entry for it inside
    // the actor event that owns the scope, so the entry carries the scope.
    globalThis.__mintMarker = () => {
      const target = { increment: (n) => n + 100 };
      __beginActorEvent('Counter:bridge');
      try {
        const entry = __newEntry(target);
        __bridgeEntry = entry;
        return { __celld$stub: entry.id, t: __stubIsolate,
                 c: false, s: entry.scope };
      } finally { __endActorEvent(); }
    };
  `);
  const envB = makeEnv();
  // B's host bridge op routes the call back to A's dispatch receiver.
  envB.sandbox.__stub_bridge = (scope, entryId, method, payload) =>
    envA.sandbox.__dispatchRpc(scope, method, payload);

  const marker = await envA.run('__mintMarker()');
  const out = await envB.run(`
    (async () => {
      const stub = __celldStubRevive(${JSON.stringify(marker)});
      const value = await stub.increment(5);
      return { value, isBridge: Object.getPrototypeOf(stub) ===
          Object.getPrototypeOf((() => { try { return __makeBridgeStub(
              { entry: { id: 0 }, scope: 'x', entryId: 0, disposed: false,
                ctx: __ctxNow() }); } catch { return null; } })() ?? undefined) };
    })()
  `);
  assert.equal(out.value, 105);
});

test('the owning isolate answers bridged ops through its stub entry', async () => {
  // Lower-level: B bridges; A's __dispatchRpc('__celld$stub:invoke') runs the
  // recorded target and the reply decodes on B.
  const envA = makeEnv();
  envA.run(`
    globalThis.__target = { hello: (name) => 'hello ' + name };
    globalThis.__mint = () => {
      __beginActorEvent('Counter:own');
      try {
        const entry = __newEntry(__target);
        __entryId = entry.id;
        return { __celld$stub: entry.id, t: __stubIsolate,
                 c: false, s: entry.scope };
      } finally { __endActorEvent(); }
    };
  `);
  const marker = await envA.run('__mint()');

  const envB = makeEnv();
  envB.sandbox.__stub_bridge = (scope, entryId, method, payload) =>
    envA.sandbox.__dispatchRpc(scope, method, payload);

  const out = await envB.run(`
    (async () => {
      const stub = __celldStubRevive(${JSON.stringify(marker)});
      return await stub.hello('world');
    })()
  `);
  assert.equal(out, 'hello world');
});

// --- Alarm delivery -------------------------------------------------------------

test('__fireAlarm delivers the alarm handler with SDK arguments', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  env.run(`
    __cell.classes.AlarmDO = class AlarmDO extends __cf.DurableObject {
      async alarm(alarmInfo) {
        __seen.push({
          scheduledTime: alarmInfo.scheduledTime,
          retryCount: alarmInfo.retryCount,
          isRetry: alarmInfo.isRetry,
        });
        // Re-arm for the next occurrence, as the SDK documents.
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    };
    globalThis.__seen = [];
  `);
  const scheduledTime = Date.now() - 5;
  await env.run(`__fireAlarm('AlarmDO:al1', ${scheduledTime}, 1)`);
  const seen = JSON.parse(JSON.stringify(env.sandbox.__seen));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scheduledTime, scheduledTime);
  assert.equal(seen[0].retryCount, 1);
  assert.equal(seen[0].isRetry, true);
});

// --- Hibernatable WebSocket delivery --------------------------------------------

test('ws delivery: message and clean close reach handlers', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  env.run(`
    __cell.classes.WsDO = class WsDO extends __cf.DurableObject {
      async webSocketMessage(ws, msg) { __wsSeen.push(['message', String(msg)]); }
      async webSocketClose(ws, code, reason, wasClean) {
        __wsSeen.push(['close', code, wasClean]);
      }
      async webSocketError(ws, err) { __wsSeen.push(['error', err.message]); }
    };
    globalThis.__wsSeen = [];
    globalThis.__ws_accept = () => {};
    globalThis.__heap_over_admission_share = () => false;
    globalThis.__ws_list = () => '[]';
    globalThis.__state = new DurableObjectState('WsDO:ws9');
  `);
  await env.run(`__wsMessage('WsDO:ws9', 'ws9', 'hello')`);
  await env.run(`__wsClosed('WsDO:ws9', 'ws9', 1005, '', true)`);
  const seen = JSON.parse(JSON.stringify(env.sandbox.__wsSeen));
  assert.deepEqual(seen, [
    ['message', 'hello'],
    ['close', 1005, true],
  ]);
});

test('ws delivery: abnormal close surfaces webSocketError', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  env.run(`
    __cell.classes.WsDO2 = class WsDO2 extends __cf.DurableObject {
      async webSocketError(ws, err) { __wsSeen2.push(['error', err.message]); }
    };
    globalThis.__wsSeen2 = [];
    globalThis.__ws_accept = () => {};
    globalThis.__heap_over_admission_share = () => false;
    globalThis.__ws_list = () => '[]';
    globalThis.__state = new DurableObjectState('WsDO2:ws2');
  `);
  await env.run(`__wsClosed('WsDO2:ws2', 'ws22', 1006, 'abnormal', false)`);
  const seen = JSON.parse(JSON.stringify(env.sandbox.__wsSeen2));
  assert.equal(seen.length, 1);
  assert.match(seen[0][1], /abnormal/);
});

// --- SQL cursor semantics --------------------------------------------------------

test('sql cursor: a deferred host error surfaces after the last good row', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  env.sandbox.__sql_cursor_start = () => ({
    columns: ['x'], rowsWritten: 0, cursorId: 7, row: [1],
  });
  env.sandbox.__sql_cursor_next = () => {
    throw new Error('disk I/O error');
  };
  const out = await env.run(`(() => {
    const cursor = __state.storage.sql.exec('SELECT x FROM t');
    const rows = [];
    let deferredError = null;
    try {
      for (const row of cursor) rows.push(row);
    } catch (e) { deferredError = e.message; }
    return { rows, deferredError };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(out.rows)), [{ x: 1 }]);
  assert.match(out.deferredError, /disk I\/O error/);
});

test('sql cursor: the final rowsWritten lands on the cursor', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  let calls = 0;
  env.sandbox.__sql_cursor_start = () => ({
    columns: ['x'], rowsWritten: 0, cursorId: 3, row: [1],
  });
  env.sandbox.__sql_cursor_next = () => {
    calls++;
    return calls === 1 ? [2] : 1; // one more row, then the final count
  };
  const out = await env.run(`(() => {
    const cursor = __state.storage.sql.exec('SELECT x FROM t');
    const rows = [];
    for (const row of cursor) rows.push(row);
    return { rows, rowsWritten: cursor.rowsWritten };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(out.rows)), [{ x: 1 }, { x: 2 }]);
  assert.equal(out.rowsWritten, 1);
});

test('sql.ingest propagates host errors; databaseSize reaches the host', async () => {
  const env = makeEnv();
  storageTestSetup(env);
  env.sandbox.__sql_ingest = (scope, input) =>
    JSON.stringify({ error: 'syntax problem' });
  env.sandbox.__sql_database_size = (scope) => 4096;
  const out = await env.run(`(() => {
    const sql = __state.storage.sql;
    let ingestError = null;
    try { sql.ingest('CREATE TABLE bad'); }
    catch (e) { ingestError = e.message; }
    return { ingestError, size: sql.databaseSize };
  })()`);
  assert.match(out.ingestError, /SQL error: syntax problem/);
  assert.equal(out.size, 4096);
});
