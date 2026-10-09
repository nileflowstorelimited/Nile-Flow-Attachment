'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createServer } = require('./server');

const PORTAL_ORIGIN = 'https://nile-flow-attachment.onrender.com';
const UPSTREAM_URL = 'https://script.google.com/macros/s/test-deployment/exec';
const ID_TOKEN = 'x'.repeat(120);
let server;
let baseUrl;
let upstreamCalls;

before(async () => {
  upstreamCalls = [];
  server = createServer({
    upstreamUrl: UPSTREAM_URL,
    portalOrigin: PORTAL_ORIGIN,
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, member: { name: 'Test Member' }, tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('forwards portal API requests and returns the Apps Script JSON with CORS headers', async () => {
  const payload = { action: 'getMyTasks', idToken: ID_TOKEN };
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), PORTAL_ORIGIN);
  assert.deepEqual(await response.json(), { ok: true, member: { name: 'Test Member' }, tasks: [] });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, UPSTREAM_URL);
  assert.equal(upstreamCalls[0].options.body, JSON.stringify(payload));
});

test('answers valid CORS preflight requests', async () => {
  const response = await fetch(`${baseUrl}/api`, {
    method: 'OPTIONS',
    headers: { Origin: PORTAL_ORIGIN, 'Access-Control-Request-Method': 'POST' }
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), PORTAL_ORIGIN);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
});

test('rejects requests from other origins without forwarding them', async () => {
  const previousCalls = upstreamCalls.length;
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'getMyTasks', idToken: ID_TOKEN })
  });

  assert.equal(response.status, 403);
  assert.equal(upstreamCalls.length, previousCalls);
});

test('rejects malformed or unsupported API requests', async () => {
  const previousCalls = upstreamCalls.length;
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'getMyTasks', idToken: 'short' })
  });

  assert.equal(response.status, 400);
  assert.equal(upstreamCalls.length, previousCalls);
});

test('rejects oversized request bodies without forwarding them', async () => {
  const previousCalls = upstreamCalls.length;
  const response = await fetch(`${baseUrl}/api`, {
    method: 'POST',
    headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'text/plain' },
    body: 'x'.repeat(20001)
  });

  assert.equal(response.status, 413);
  assert.equal(upstreamCalls.length, previousCalls);
});
