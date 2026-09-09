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
