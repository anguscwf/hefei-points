const childProcess = require('node:child_process');
const cluster = require('node:cluster');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const workerThreads = require('node:worker_threads');

const LOOPBACK_HOST = '127.0.0.1';
const ERROR_CODE = 'SYNTHETIC_NETWORK_FORBIDDEN';

function forbidden(kind) {
  const error = new Error(`synthetic test forbids ${kind}`);
  error.code = ERROR_CODE;
  return error;
}

function assertLoopbackSocket(args) {
  const first = args[0];
  let options;
  if (Array.isArray(first) && first[0] && typeof first[0] === 'object') {
    [options] = first;
  } else if (first && typeof first === 'object') {
    options = first;
  } else if (typeof first === 'number') {
    options = {
      port: first,
      host: typeof args[1] === 'string' ? args[1] : undefined
    };
  } else {
    throw forbidden('non-TCP or unscoped socket connection');
  }
  if (options.path !== undefined) {
    throw forbidden('IPC socket connection');
  }
  const host = options.hostname ?? options.host;
  const port = Number(options.port);
  if (host !== LOOPBACK_HOST || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw forbidden('non-loopback TCP connection');
  }
}

function assertLoopbackListener(args) {
  const first = args[0];
  let host;
  let port;
  if (first && typeof first === 'object') {
    if (first.path !== undefined || first.fd !== undefined) {
      throw forbidden('non-TCP listener');
    }
    host = first.host;
    port = Number(first.port);
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : undefined;
    port = first;
  } else {
    throw forbidden('unscoped listener');
  }
  if (host !== LOOPBACK_HOST || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw forbidden('non-loopback listener');
  }
}

function requestUrl(input, options) {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  const requestOptions = input && typeof input === 'object' ? input : options;
  if (!requestOptions || typeof requestOptions !== 'object') {
    throw forbidden('unscoped HTTP request');
  }
  const protocol = requestOptions.protocol || 'http:';
  const host = requestOptions.hostname || requestOptions.host;
  const port = requestOptions.port || (protocol === 'http:' ? '80' : '443');
  return new URL(`${protocol}//${host}:${port}${requestOptions.path || '/'}`);
}

function assertLoopbackHttp(input, options) {
  let url;
  try {
    url = requestUrl(input, options);
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw forbidden('invalid HTTP request target');
  }
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw forbidden('non-loopback HTTP request');
  }
}

function installLoopbackOnlyNetwork() {
  const restorers = [];
  const replace = (target, key, replacement) => {
    const original = target[key];
    target[key] = replacement(original);
    restorers.push(() => {
      target[key] = original;
    });
  };

  replace(net.Socket.prototype, 'connect', original => function guardedSocketConnect(...args) {
    assertLoopbackSocket(args);
    return original.apply(this, args);
  });
  replace(net.Server.prototype, 'listen', original => function guardedServerListen(...args) {
    assertLoopbackListener(args);
    return original.apply(this, args);
  });
  for (const key of ['connect', 'createConnection']) {
    replace(net, key, original => function guardedNetConnect(...args) {
      assertLoopbackSocket(args);
      return original.apply(this, args);
    });
  }
  replace(http, 'request', original => function guardedHttpRequest(input, options, callback) {
    assertLoopbackHttp(input, options);
    return original.call(this, input, options, callback);
  });
  replace(http, 'get', original => function guardedHttpGet(input, options, callback) {
    assertLoopbackHttp(input, options);
    return original.call(this, input, options, callback);
  });

  for (const [target, keys, kind] of [
    [https, ['request', 'get'], 'HTTPS request'],
    [tls, ['connect'], 'TLS connection'],
    [http2, ['connect'], 'HTTP/2 connection'],
    [dgram, ['createSocket'], 'UDP socket']
  ]) {
    for (const key of keys) {
      replace(target, key, () => function blockedNetworkApi() {
        throw forbidden(kind);
      });
    }
  }
  for (const key of [
    'addMembership', 'addSourceSpecificMembership', 'bind', 'connect', 'send', 'sendto'
  ]) {
    if (typeof dgram.Socket.prototype[key] === 'function') {
      replace(dgram.Socket.prototype, key, () => function blockedDatagramOperation() {
        throw forbidden('UDP socket operation');
      });
    }
  }

  const dnsMethods = [
    'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
    'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'
  ];
  for (const key of dnsMethods) {
    if (typeof dns[key] === 'function') {
      replace(dns, key, original => function guardedDnsApi(hostname, ...args) {
        if (key !== 'lookup' || hostname !== LOOPBACK_HOST) {
          throw forbidden('DNS lookup');
        }
        return original.call(this, hostname, ...args);
      });
    }
    if (dns.promises && typeof dns.promises[key] === 'function') {
      replace(dns.promises, key, original => function guardedDnsPromiseApi(hostname, ...args) {
        if (key !== 'lookup' || hostname !== LOOPBACK_HOST) {
          throw forbidden('DNS lookup');
        }
        return original.call(this, hostname, ...args);
      });
    }
  }
  for (const resolver of [
    dns.Resolver && dns.Resolver.prototype,
    dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype
  ].filter(Boolean)) {
    for (const key of dnsMethods) {
      if (typeof resolver[key] === 'function') {
        replace(resolver, key, () => function blockedResolverApi() {
          throw forbidden('DNS resolver query');
        });
      }
    }
  }

  if (typeof globalThis.fetch === 'function') {
    replace(globalThis, 'fetch', original => function guardedFetch(input, init) {
      const target = input && typeof input === 'object' && typeof input.url === 'string'
        ? input.url
        : input;
      assertLoopbackHttp(target);
      return original.call(this, input, { ...(init || {}), redirect: 'manual' });
    });
  }
  if (typeof globalThis.WebSocket === 'function') {
    replace(globalThis, 'WebSocket', () => function BlockedWebSocket() {
      throw forbidden('WebSocket connection');
    });
  }
  for (const key of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
    if (typeof childProcess[key] === 'function') {
      replace(childProcess, key, () => function blockedChildProcess() {
        throw forbidden('child process');
      });
    }
  }
  if (childProcess.ChildProcess
      && typeof childProcess.ChildProcess.prototype.spawn === 'function') {
    replace(childProcess.ChildProcess.prototype, 'spawn', () => function blockedProcessSpawn() {
      throw forbidden('child process');
    });
  }
  if (typeof cluster.fork === 'function') {
    replace(cluster, 'fork', () => function blockedClusterFork() {
      throw forbidden('cluster worker');
    });
  }
  if (typeof workerThreads.Worker === 'function') {
    replace(workerThreads, 'Worker', () => function BlockedWorker() {
      throw forbidden('worker thread');
    });
  }

  let restored = false;
  return function restoreNetwork() {
    if (restored) return;
    restored = true;
    for (let index = restorers.length - 1; index >= 0; index -= 1) {
      restorers[index]();
    }
  };
}

module.exports = {
  ERROR_CODE,
  installLoopbackOnlyNetwork
};
