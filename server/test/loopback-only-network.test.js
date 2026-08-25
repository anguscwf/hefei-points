const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const cluster = require('node:cluster');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const workerThreads = require('node:worker_threads');

const {
  ERROR_CODE,
  installLoopbackOnlyNetwork
} = require('../test-support/loopback-only-network');

function assertForbidden(callback) {
  assert.throws(callback, error => error && error.code === ERROR_CODE);
}

test('synthetic network guard rejects external transports and restores every patch', async () => {
  const originals = {
    childSpawn: childProcess.spawn,
    clusterFork: cluster.fork,
    createSocket: dgram.createSocket,
    datagramBind: dgram.Socket.prototype.bind,
    datagramSend: dgram.Socket.prototype.send,
    fetch: globalThis.fetch,
    lookup: dns.lookup,
    netConnect: net.connect,
    promiseResolverResolve4: dns.promises.Resolver.prototype.resolve4,
    resolverResolve4: dns.Resolver.prototype.resolve4,
    request: https.request,
    serverListen: net.Server.prototype.listen,
    worker: workerThreads.Worker
  };
  const restore = installLoopbackOnlyNetwork();
  let redirectServer;
  try {
    assertForbidden(() => dns.lookup('example.invalid', () => {}));
    assertForbidden(() => new dns.Resolver().resolve4('example.invalid', () => {}));
    assertForbidden(() => new dns.promises.Resolver().resolve4('example.invalid'));
    assertForbidden(() => net.connect({ host: '192.0.2.1', port: 443 }));
    assertForbidden(() => https.request('https://example.invalid/'));
    assertForbidden(() => dgram.createSocket('udp4'));
    assertForbidden(() => dgram.Socket.prototype.bind.call({}, 0, '0.0.0.0'));
    assertForbidden(() => dgram.Socket.prototype.send.call({}, Buffer.from('x'), 53));
    assertForbidden(() => globalThis.fetch('http://example.invalid/'));
    assertForbidden(() => net.createServer().listen(0, '0.0.0.0'));
    assertForbidden(() => childProcess.spawn(process.execPath, ['-e', '']));
    assertForbidden(() => cluster.fork());
    assertForbidden(() => new workerThreads.Worker(''));
    redirectServer = http.createServer((request, response) => {
      response.writeHead(302, { Location: 'http://example.invalid/redirect-target' });
      response.end();
    });
    await new Promise((resolve, reject) => {
      redirectServer.once('error', reject);
      redirectServer.listen(0, '127.0.0.1', resolve);
    });
    const redirected = await globalThis.fetch(
      `http://127.0.0.1:${redirectServer.address().port}/redirect-source`
    );
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), 'http://example.invalid/redirect-target');
  } finally {
    if (redirectServer && redirectServer.listening) {
      await new Promise(resolve => redirectServer.close(resolve));
    }
    restore();
  }

  assert.equal(dgram.createSocket, originals.createSocket);
  assert.equal(dgram.Socket.prototype.bind, originals.datagramBind);
  assert.equal(dgram.Socket.prototype.send, originals.datagramSend);
  assert.equal(globalThis.fetch, originals.fetch);
  assert.equal(dns.lookup, originals.lookup);
  assert.equal(net.connect, originals.netConnect);
  assert.equal(dns.promises.Resolver.prototype.resolve4, originals.promiseResolverResolve4);
  assert.equal(dns.Resolver.prototype.resolve4, originals.resolverResolve4);
  assert.equal(https.request, originals.request);
  assert.equal(net.Server.prototype.listen, originals.serverListen);
  assert.equal(childProcess.spawn, originals.childSpawn);
  assert.equal(cluster.fork, originals.clusterFork);
  assert.equal(workerThreads.Worker, originals.worker);
});
