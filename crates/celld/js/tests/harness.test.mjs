// Standalone unit tests for the Cloudflare-compatible object model that
// crates/celld/js/harness.js implements: stub protocol, entrypoint RPC,
// serialization markers, and the Workers/Durable Objects API surface that
// needs no live node.
//
// The harness is loaded into a fresh VM context per test with every host op
// (the `"__x" => op_x` dispatch table in crates/celld/js.rs) replaced by a
// mock that throws, so a test that touches an un-mocked host path fails
// loudly instead of silently passing against the wrong semantics. Ops a
// test relies on are overridden explicitly.
//
// Run:  node --test crates/celld/js/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(here, '..', 'harness.js');
const HARNESS_SRC = readFileSync(HARNESS_PATH, 'utf8');
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
  const found = [...JSRS_SRC.matchAll(/"(__[a-zA-Z_$][a-zA-Z0-9_$]*)"\s*=>/g)].map(
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
function makeEnv() {
  const env = { logs: [], opCalls: new Map() };
  const sandbox = standardGlobals();
  sandbox.__hostLogs = [];
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
  // Event begin/end frame bookkeeping is driver state the unit tests do not
  // model; the object-model semantics under test do not depend on it.
  sandbox.__event_begin = () => {};
  sandbox.__event_end = () => {};
  // DO ids are host-derived (HMAC'd) in real celld; a stable synthetic value
  // is enough for unit tests.
  sandbox.__do_id = (ns, kind, name) => name || `${ns}:${kind}`;
  // Structured-clone codec: Node's v8 serializer is the same format the host
  // uses to move values between isolates.
  sandbox.__sc_encode = (value) => serialize(value);
  sandbox.__sc_decode = (bytes) => deserialize(bytes);
  let ioContextSeq = 0;
  sandbox.__io_context_id = () => ++ioContextSeq;
  sandbox.console = {
    log: (...a) => env.logs.push(a.map(fmt).join(' ')),
    error: (...a) => env.logs.push(a.map(fmt).join(' ')),
    warn: (...a) => env.logs.push(a.map(fmt).join(' ')),
    debug: () => {},
    info: (...a) => env.logs.push(a.map(fmt).join(' ')),
  };
  vm.createContext(sandbox);
  vm.runInContext(HARNESS_SRC, sandbox, { filename: 'harness.js' });
  env.sandbox = sandbox;
  env.run = (code, name = 'test-driver') =>
    vm.runInContext(code, sandbox, { filename: name });
  return env;
}

test('harness loads standalone with host ops mocked', () => {
  const env = makeEnv();
  assert.equal(typeof env.sandbox.__cf.RpcStub, 'function');
  assert.equal(typeof env.sandbox.__dispatchEntrypointRpc, 'function');
  assert.ok(Array.isArray(env.sandbox.__cell.crons));
});

// --- stub protocol: dup ----------------------------------------------------

test('dup on a ctx.exports loopback stub mints a distinct stub locally', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__cell.entrypoints.Counter = class Counter {
      async increment(n) { return n + 1; }
    };
  `);
  env.run(`
    globalThis.__t = (svc, other) => {
      const calls = { count: 0 };
      const a = svc;
      const b = svc.dup();
      return {
        distinct: a !== b,
        callableProps: typeof b.increment === 'function',
      };
    };
  `);
  const out = env.run(`
    const svc = __entrypointStub('Counter');
    __t(svc, null);
  `);
  assert.equal(out.distinct, true);
  assert.equal(out.callableProps, true);
});

test('dup on a foreign service stub mints locally and never bridges', () => {
  const env = makeEnv();
  // Any host op touched during dup is a regression of the wire-dup bug:
  // dup is stub protocol and must answer without dispatching.
  env.run(`
    globalThis.__t = () => {
      const marker = {
        __celld$svc: 'AgentSelfLoopback',
        c: 'workshop-backend',
        p: { overseerId: 'abc', chatId: 2 },
      };
      const stub = __celldStubRevive(marker);
      const callsBefore = JSON.stringify(Object.keys(globalThis));
      const duped = stub.dup();
      return {
        serviceShaped: Object.getPrototypeOf(duped) === Object.getPrototypeOf(stub),
        distinct: duped !== stub,
        stillCallable: typeof duped.reportMove === 'function',
      };
    };
    __t();
  `);
  const out = env.run('__t()');
  assert.equal(out.serviceShaped, true);
  assert.equal(out.distinct, true);
  assert.equal(out.stillCallable, true);
});

test('a foreign service stub round-trips revive: props ride along', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = () => {
      const marker = {
        __celld$svc: 'AgentSelfLoopback',
        c: 'workshop-backend',
        p: { overseerId: 'abc', chatId: 7 },
      };
      const stub = __celldStubRevive(marker);
      const meta = __svcMeta.get(stub);
      return {
        name: meta.name,
        script: meta.scriptRef ?? null,
        propsChat: meta.props && meta.props.chatId,
      };
    };
  `);
  const out = env.run('__t()');
  assert.equal(out.name, 'AgentSelfLoopback');
  assert.equal(out.propsChat, 7);
});

// --- stub protocol: shape --------------------------------------------------

test('stubs are not thenables', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__cell.entrypoints.Plain = class Plain { async ping() {} };
    globalThis.__t = () => {
      const svc = __entrypointStub('Plain');
      const foreign = __celldStubRevive({
        __celld$svc: 'SomeLoopback', c: 'workshop-backend',
      });
      return {
        svcThen: svc.then,
        foreignThen: foreign.then,
        svcTypeof: typeof svc,
      };
    };
  `);
  const out = env.run('__t()');
  assert.equal(out.svcThen, undefined);
  assert.equal(out.foreignThen, undefined);
  assert.equal(out.svcTypeof, 'function');
});

test('entrypoint method resolution refuses reserved and missing names', async () => {
  const env = makeEnv();
  env.run(`
    globalThis.__cell.entrypoints.Worker = class Worker {
      async ping() { return 'pong'; }
    };
  `);
  const call = (method) => env.run(
      `__dispatchEntrypointRpc('Worker', ['${method}'], __rpcOut([], true), null, false)`);
  // A refused method comes back as a tagged error reply; the CALLER's decode
  // is what throws (matching how a real stub surfaces it).
  const decodeReply = (reply) => env.run(
      `__rpcDes(new Uint8Array([${new Uint8Array(reply).join(',')}]))`);
  const refused = await call('fetch');
  assert.throws(() => decodeReply(refused), /reserved/i);
  const missing = await call('nope');
  assert.throws(
      () => decodeReply(missing), /no such method|does not implement|NoSuchMethod/i);
  // An exposed prototype method answers; the tagged reply decodes to 'pong'.
  const reply = await call('ping');
  assert.equal(decodeReply(reply), 'pong');
});

// --- serialization markers --------------------------------------------------

test('rpc envelope lifts functions as callable loopback stubs', async () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = async () => {
      const fn = (x) => x + 1;
      const out = __rpcOut([fn], true);
      const back = __rpcDes(out);
      return { callable: typeof back[0] === 'function', answer: await back[0](41) };
    };
  `);
  const out = await env.run('__t()');
  assert.equal(out.callable, true);
  assert.equal(out.answer, 42);
});

test('rpc envelope carries DO stubs that route back to their cell', async () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = async () => {
      __cell.namespaceKeys.Widget = 'widget-key';
      const ns = __cell.makeNamespace('Widget');
      const stub = ns.get(ns.idFromName('w1'));
      const out = __rpcOut([stub], true);
      const back = __rpcDes(out);
      const routed = [];
      globalThis.__rpc_call = (scope, name, method, args) => {
        routed.push({ scope, method });
        return Promise.resolve(__sc_encode('ok'));
      };
      await back[0].increment(1);
      return {
        stillDoStub: Reflect.has(back[0], '__celldDo'),
        routed: routed[0] || null,
      };
    };
  `);
  const out = await env.run('__t()');
  assert.equal(out.stillDoStub, true);
  assert.equal(out.routed.method, 'increment');
  assert.ok(out.routed.scope.startsWith('Widget:'), out.routed.scope);
});

test('storage refuses transient RPC stubs but keeps service stubs', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = () => {
      const results = {};
      const svc = __entrypointStub('Counter');
      results.svcOk = (() => { try { __storedLift(svc); return true; } catch { return false; } })();
      const rpcTarget = new (class Target extends __cf.RpcTarget {})();
      results.transientRefused = (() => {
        try { __storedLift(rpcTarget); return false; }
        catch (e) { return e.name === 'DataCloneError' || /durable|transient|stub/i.test(e.message); }
      })();
      return results;
    };
  `);
  const out = env.run('__t()');
  assert.equal(out.svcOk, true);
  assert.equal(out.transientRefused, true);
});

// --- pipelining -------------------------------------------------------------

test('pipelined property chains cap their depth like workerd', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = () => {
      try {
        let node = __makeNode({ get: () => Promise.reject(new Error('x')), call: () => {} }, ['a'], null);
        for (let i = 0; i < 5200; i++) node = node.deep;
        node.push('x');
        return 'no-error';
      } catch (e) { return /too deep/.test(e.message) ? 'capped' : 'other: ' + e.message; }
    };
  `);
  const out = env.run('__t()');
  assert.equal(out, 'capped');
});

// --- local value walk ---------------------------------------------------------

test('walkLocal invokes methods and reports missing ones', () => {
  const env = makeEnv();
  env.run(`
    globalThis.__t = () => {
      const out = {};
      out.add = __walkLocal({ add: (a, b) => a + b }, ['add'], [1, 2]);
      try { __walkLocal({}, ['missing'], [1]); out.missing = 'no-throw'; }
      catch (e) { out.missing = /not a function|no such method|missing/i.test(e.message) ? 'refused' : e.message; }
      return out;
    };
  `);
  const out = env.run('__t()');
  assert.equal(out.add, 3);
  assert.equal(out.missing, 'refused');
});
