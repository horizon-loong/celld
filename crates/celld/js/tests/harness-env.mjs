// Shared test environment for the standalone harness tests: loads
// crates/celld/js/harness.js into a fresh VM context with every host op
// (the `"__x" => op_x` dispatch table in crates/celld/js.rs) mocked to
// throw, so tests opt in to exactly the host surface they exercise.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'node:v8';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_SRC = readFileSync(
    path.join(here, '..', 'harness.js'), 'utf8');
const JSRS_SRC = (() => {
  try {
    return readFileSync(path.join(here, '..', '..', 'js.rs'), 'utf8');
  } catch {
    return '';
  }
})();

// Every host op name from the js.rs dispatch table. Falls back to a small
// essential set when the runtime source is not next to the tests.
function hostOpNames() {
  const found =
      [...JSRS_SRC.matchAll(/"(__[a-zA-Z_$][a-zA-Z0-9_$]*)"\s*=>/g)].map(
          (m) => m[1]);
  return found.length > 0 ? [...new Set(found)] : [
    '__log', '__rpc_call', '__do_call', '__svc_rpc', '__stub_bridge',
    '__wait_until', '__event_begin', '__event_end', '__do_id',
    '__structured_clone',
  ];
}

// Standard globals the harness assumes from the V8/Web prelude. Node ships
// equivalents for all of them.
function standardGlobals() {
  const pick = [
    TextEncoder, TextDecoder, URL, URLSearchParams, Blob, File, FormData,
    Headers, Request, Response, Event, EventTarget, CustomEvent,
    AbortController, AbortSignal, DOMException, ReadableStream,
    WritableStream, TransformStream, structuredClone, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto,
  ];
  const out = {};
  for (const value of pick) {
    if (value !== undefined) out[value.name] = value;
  }
  return out;
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// A fresh isolate-shaped context: host ops throw until a test mocks them,
// `__log` is captured for assertions, and the harness is loaded.
export function makeEnv() {
  const env = { logs: [], opCalls: new Map() };
  const sandbox = standardGlobals();
  for (const name of hostOpNames()) {
    sandbox[name] = (...args) => {
      env.opCalls.set(name, (env.opCalls.get(name) ?? 0) + 1);
      throw new Error(`host op ${name} is not mocked for this test`);
    };
  }
  sandbox.__log = (...args) => {
    env.logs.push(args.map((a) => typeof a === 'string' ? a : fmt(a)).join(' '));
  };
  // The async-local-storage token `__ctxNow`/`__ctxRun` read and rebuild is
  // a Map of context keys, so the identity must be a real Map.
  const ctxToken = new Map();
  sandbox.__als_get = () => ctxToken;
  sandbox.__als_set = () => {};
  // DO ids are host-derived (HMAC'd) in real celld; a stable synthetic value
  // is enough for unit tests.
  sandbox.__do_id = (ns, kind, name) => name || `${ns}:${kind}`;
  // Structured-clone codec: Node's v8 serializer is the same format the host
  // uses to move values between isolates.
  sandbox.__sc_encode = (value) => serialize(value);
  sandbox.__sc_decode = (bytes) => deserialize(bytes);
  let ioContextSeq = 0;
  sandbox.__io_context_id = () => ++ioContextSeq;
  // Event begin/end frame bookkeeping is driver state the unit tests do not
  // model; the object-model semantics under test do not depend on it.
  sandbox.__event_begin = () => {};
  sandbox.__event_end = () => {};
  vm.createContext(sandbox);
  vm.runInContext(HARNESS_SRC, sandbox, { filename: 'harness.js' });
  env.sandbox = sandbox;
  env.run = (code, name = 'test-driver') =>
    vm.runInContext(code, sandbox, { filename: name });
  return env;
}


// Install an in-memory emulation of the host storage ops (tagged rows,
// snapshot transaction control, per-scope alarms) and create a
// DurableObjectState for the given scope. Returns { alarm, keys } probes.
export function storageTestSetup(env, scope = 'Counter:test-scope', options = {}) {
  const { deleteAllDeletesAlarm = false } = options;
  const sentinel = env.run('__storedSentinel');
  const spaces = new Map();
  const alarms = new Map();
  const snapshots = new Map();
  const space = (sc) => {
    let m = spaces.get(sc);
    if (!m) spaces.set(sc, (m = new Map()));
    return m;
  };
  const s = env.sandbox;
  s.__storage_get = (sc, key, sent) => {
    const m = spaces.get(sc);
    return m && m.has(key) ? m.get(key) : [sent];
  };
  s.__storage_get_many = (sc, keys, sent) => {
    const m = spaces.get(sc) ?? new Map();
    const found = new Map();
    for (const k of keys) if (m.has(k)) found.set(k, m.get(k));
    return [sent, found];
  };
  s.__storage_queue_put = (sc, key, value) => {
    space(sc).set(key, [sentinel, value]);
  };
  s.__storage_queue_put_many = (sc, entries) => {
    const m = space(sc);
    for (const [k, v] of entries) m.set(k, [sentinel, v]);
  };
  s.__storage_flush_pending_puts = () => {};
  s.__storage_put = (sc, key, value) => {
    space(sc).set(key, [sentinel, value]);
  };
  s.__storage_put_serialized = s.__storage_put;
  s.__storage_delete = (sc, key) => {
    const m = spaces.get(sc);
    return m ? m.delete(key) : false;
  };
  s.__storage_delete_many = (sc, keys) => {
    const m = spaces.get(sc);
    let n = 0;
    for (const k of keys) if (m.delete(k)) n++;
    return n;
  };
  s.__storage_delete_all = (sc) => {
    spaces.set(sc, new Map());
    if (deleteAllDeletesAlarm) alarms.delete(sc);
  };
  s.__storage_list = (sc, optionsJson, sent) => {
    const o = JSON.parse(optionsJson);
    const m = spaces.get(sc) ?? new Map();
    let rows = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
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
  s.__storage_transaction_control = (sc, op, nested, savepoint) => {
    if (op === 'start') snapshots.set(savepoint, new Map(space(sc)));
    else if (op === 'commit') snapshots.delete(savepoint);
    else if (op === 'rollback' || op === 'rollback_explicit') {
      const snap = snapshots.get(savepoint);
      if (snap) spaces.set(sc, new Map(snap));
      snapshots.delete(savepoint);
    }
  };
  s.__storage_cancel_pending_puts = () => 0;
  s.__storage_sync_list_start = (sc, optionsJson) => {
    const o = JSON.parse(optionsJson);
    const m = space(sc) ?? new Map();
    let rows = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (o.prefix) rows = rows.filter(([k]) => k.startsWith(o.prefix));
    if (o.limit > 0) rows = rows.slice(0, o.limit);
    return { rows: rows.map(([k, v]) => [k, v]) };
  };
  s.__storage_sync_list_next = (cursor) =>
    cursor.rows.length > 0 ? cursor.rows.shift() : null;
  s.__alarm_set = (sc, t) => alarms.set(sc, t);
  s.__alarm_get = (sc) => (alarms.has(sc) ? alarms.get(sc) : null);
  s.__alarm_delete = (sc) => alarms.delete(sc);
  s.__cell.deleteAllDeletesAlarm = deleteAllDeletesAlarm;
  // Expose the state as `__state` for snippets (and register it under the
  // scope so host-side state lookups in tests can find it).
  env.run(`
    globalThis.__state = new DurableObjectState('${scope}');
    globalThis.__states = globalThis.__states || {};
    globalThis.__states['${scope}'] = __state;
  `);
  return {
    alarm: (sc) => alarms.get(sc),
    keys: (sc) => [...(spaces.get(sc)?.keys() ?? [])],
  };
}

export function makeState(env, scope = 'Counter:test-scope') {
  return env.run(`
    globalThis.__states = globalThis.__states || {};
    __state = new DurableObjectState('${scope}');
    globalThis.__states['${scope}'] = __state;
    __state;
  `);
}
