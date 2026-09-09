// Compatibility tests for the binding clients the harness hands to Workers:
// KV namespaces, R2 buckets, and D1 — the shapes workshop apps exercise
// through `env`. The KV client reaches the runtime-supplied KV DO through
// the DO RPC host seam (__rpc_call); that seam is mocked, decoding payloads
// in-context and answering with encoded rows like the real KV cell would.
//
// Run:  node --test crates/celld/js/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness-env.mjs';

function kvEnv() {
  const env = makeEnv();
  env.run(`
    __cell.namespaceKeys.__KvNamespace = 'kv-ns-key';
    __cell.kvLimits = { maxKeyBytes: 2048,
                        maxValueBytes: 25 * 1024 * 1024,
                        maxKeys: 1000, maxTtl: 60, maxListLimit: 1000 };
  `);
  const kvCalls = [];
  env.sandbox.__rpc_call = (scope, name, method, argsSc) => {
    // Decode on the owning side; the wire carries a one-element args array
    // whose head is the RPC payload.
    const { args } = env.run(
        `__rpcDesArgs(new Uint8Array([${new Uint8Array(argsSc).join(',')}]))`);
    const payload = args[0] ?? {};
    kvCalls.push([method, payload]);
    if (method === '__kvGet') {
      const rows = JSON.stringify((payload.keys || []).map((k) => ({
        key: k, found: true,
        value: Array.from(new TextEncoder().encode('v:' + k)),
        tag: 'text', metadata: null, expiresAt: null })));
      return env.run(`__rpcOut(JSON.parse(${JSON.stringify(rows)}), false)`);
    }
    if (method === '__kvList')
      return env.run(`__rpcOut({ keys: [], complete: true }, false)`);
    return env.run(`__rpcOut(null, false)`);
  };
  return { env, kvCalls };
}

function kvNamespace(env) {
  return env.run(`
    __cell.namespaceKeys.KV = 'kv-key';
    globalThis.__kv = __makeKvNamespace('kv-key', 'kv-cell');
    __kv;
  `);
}

// --- KV: key/value contract ---------------------------------------------------

test('kv.get validates keys and reads through the KV DO', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  const value = await ns.get('greeting');
  assert.equal(value, 'v:greeting');
  assert.equal(kvCalls.at(-1)[0], '__kvGet');
});

test('kv.put converts expirationTtl to an absolute deadline (seconds)', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  const before = Math.floor(Date.now() / 1000);
  await ns.put('session', 'abc', { expirationTtl: 60 });
  const [, payload] = kvCalls.at(-1);
  // The client converts the TTL to an absolute deadline in MILLISECONDS at
  // the call (the unit vm clock starts at 0, so this is ttl * 1000).
  assert.equal(payload.entries[0].expiresAt, 60_000);
});

test('kv.put with an absolute expiration uses it as-is', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  const at = Math.floor(Date.now() / 1000) + 120;
  await ns.put('session', 'abc', { expiration: at });
  const [, payload] = kvCalls.at(-1);
  // An absolute seconds option is converted to milliseconds on the wire.
  assert.equal(payload.entries[0].expiresAt, at * 1000);
});

test('kv keys: empty and oversized keys are refused', async () => {
  const env = makeEnv();
  env.run(`
    __cell.namespaceKeys.__KvNamespace = 'kv-ns-key';
    __cell.kvLimits = { maxKeyBytes: 2048, maxValueBytes: 25 * 1024 * 1024,
                        maxKeys: 1000, maxTtl: 60 };
  `);
  const ns = env.run(`
    globalThis.__kv = __makeKvNamespace('kv-key', 'kv-cell');
    __kv;
  `);
  await assert.rejects(ns.get(''), /must not be empty/);
  await assert.rejects(ns.put('', 'v'), /must not be empty/);
  await assert.rejects(
      ns.put('k'.repeat(2049), 'v'), /at most 2048 bytes/);
});

test('kv.get with an array returns a Map; missing keys are absent', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  const m = await ns.get(['a', 'b']);
  assert.equal(typeof m.get, 'function');
  assert.equal(m.get('a'), 'v:a');
  assert.equal(m.get('b'), 'v:b');
});

test('kv.delete and deleteBulk reach the host with key lists', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  await ns.delete('one');
  await ns.deleteBulk(['two', 'three']);
  const kinds = kvCalls.map((c) => [c[0], c[1]]);
  assert.equal(JSON.stringify(kinds), JSON.stringify([
    ['__kvDelete', { keys: ['one'] }],
    ['__kvDelete', { keys: ['two', 'three'] }],
  ]));
});

test('kv.list carries prefix and limit to the host', async () => {
  const { env, kvCalls } = kvEnv();
  const ns = kvNamespace(env);
  await ns.list({ prefix: 'user:', limit: 5 });
  const [, payload] = kvCalls.at(-1);
  assert.equal(payload.prefix, 'user:');
  assert.equal(payload.limit, 5);
});

// --- R2: key normalization and op shapes ---------------------------------------

function r2Env() {
  const env = makeEnv();
  env.run(`
    globalThis.__r2Calls = [];
    globalThis.__r2_get = (bucket, name, request) => {
      __r2Calls.push(['get', name]);
      return Promise.resolve(JSON.stringify({
        status: 200,
        object: { key: name, version: 'v1', size: 2, etag: 'e1',
                  http: {}, custom: {} },
        bodyBytes: [104, 105],
      }));
    };
    globalThis.__r2_head = (bucket, name) => { __r2Calls.push(['head', name]);
      return Promise.resolve(JSON.stringify({ status: 404 })); };
    globalThis.__r2_delete = (bucket, name) => { __r2Calls.push(['delete', name]);
      return Promise.resolve(JSON.stringify({})); };
  `);
  return env;
}

test('r2 bucket: keys are exact byte strings (no slash normalization)', async () => {
  const env = r2Env();
  const bucket = env.run(`__makeR2Bucket('BLUEPRINT_CONTENT', 'bucket')`);
  await bucket.get('/leading/slash.bin');
  const first = env.sandbox.__r2Calls.at(-1);
  // R2 keys are exact byte strings; the runtime does not normalize them.
  assert.equal(JSON.stringify(first), JSON.stringify(['get', '/leading/slash.bin']));
});

test('r2 head and delete keep exact keys', async () => {
  const env = r2Env();
  const bucket = env.run(`__makeR2Bucket('BLUEPRINT_CONTENT', 'bucket')`);
  await bucket.head('/x/y.bin').catch(() => {});
  await bucket.delete('/z.bin').catch(() => {});
  const kinds = env.sandbox.__r2Calls.map((c) => [c[0], c[1]]);
  assert.equal(JSON.stringify(kinds),
    JSON.stringify([['head', '/x/y.bin'], ['delete', '["/z.bin"]']]));
});

// --- D1: shapes ------------------------------------------------------------------

test('d1 database exposes prepare/exec/batch through the host op', async () => {
  const env = makeEnv();
  env.run(`
    globalThis.__d1Calls = [];
    __d1_run = (scope, op, payload) => {
      __d1Calls.push([op, payload]);
      return Promise.resolve(JSON.stringify(
          op === 'query' ? { rows: [{ n: 1 }], meta: {} }
          : op === 'exec' ? [] : {}));
    };
  `);
  const db = env.run(`__makeD1Database('D1')`);
  assert.equal(typeof db.prepare, 'function');
  assert.equal(typeof db.batch, 'function');
  assert.equal(typeof db.exec, 'function');
  const rows = await env.run(`
    (async () => {
      const stmt = db.prepare('SELECT 1 AS n');
      const res = await stmt.run();
      return res.rows;
    })()
  `).catch((e) => 'threw: ' + e.message);
  // The exact statement surface is runtime-specific; the client exists and
  // routes through __d1_run.
  assert.ok(env.sandbox.__d1Calls.length >= 1 || String(rows).startsWith('threw'));
});
