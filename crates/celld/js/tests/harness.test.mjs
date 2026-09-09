import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness-env.mjs';

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
