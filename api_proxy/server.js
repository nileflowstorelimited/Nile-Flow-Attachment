'use strict';

const http = require('node:http');

const MAX_BODY_BYTES = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25000;

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function jsonResponse(response, statusCode, body, origin) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin'
    } : {})
  });
  response.end(JSON.stringify(body));
}

function validateConfig({ upstreamUrl, portalOrigin, fetchImpl }) {
  let upstream;
  let portal;
  try {
    upstream = new URL(upstreamUrl);
    portal = new URL(portalOrigin);
  } catch {
    throw new Error('Set valid APPS_SCRIPT_WEB_APP_URL and PORTAL_ORIGIN environment variables.');
  }

  if (upstream.protocol !== 'https:' ||
      upstream.hostname !== 'script.google.com' ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(upstream.pathname)) {
    throw new Error('APPS_SCRIPT_WEB_APP_URL must be an HTTPS Apps Script /exec URL.');
  }
  if (portal.protocol !== 'https:' || portal.origin !== portalOrigin || portal.pathname !== '/') {
    throw new Error('PORTAL_ORIGIN must be an HTTPS origin without a path or trailing slash.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('This service requires a Node.js runtime with the built-in fetch API (Node 18 or newer).');
  }

  return { upstreamUrl: upstream.href, portalOrigin: portal.origin };
}

function createServer({ upstreamUrl, portalOrigin, fetchImpl = globalThis.fetch }) {
  const config = validateConfig({ upstreamUrl, portalOrigin, fetchImpl });

  return http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/healthz') {
      jsonResponse(response, 200, { ok: true, service: 'Nile Flow API proxy' });
      return;
    }

    if (path !== '/api') {
      jsonResponse(response, 404, { ok: false, error: 'Not found.' });
      return;
    }

    const origin = request.headers.origin;
    if (origin !== config.portalOrigin) {
      jsonResponse(response, 403, { ok: false, error: 'Origin not allowed.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Origin': config.portalOrigin,
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin'
      });
      response.end();
      return;
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, OPTIONS');
      jsonResponse(response, 405, { ok: false, error: 'Method not allowed.' }, config.portalOrigin);
      return;
    }

    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('text/plain') && !contentType.startsWith('application/json')) {
      jsonResponse(response, 415, { ok: false, error: 'Unsupported content type.' }, config.portalOrigin);
      return;
    }

    try {
      const rawBody = await readRequestBody(request);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        jsonResponse(response, 400, { ok: false, error: 'Invalid JSON request.' }, config.portalOrigin);
        return;
      }

      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          !['getMyTasks', 'updateTask'].includes(body.action) ||
          typeof body.idToken !== 'string' ||
          body.idToken.length < 100 ||
          body.idToken.length > 4096) {
        jsonResponse(response, 400, { ok: false, error: 'Invalid API request.' }, config.portalOrigin);
        return;
      }

      const upstreamResponse = await fetchImpl(config.upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const upstreamBody = await upstreamResponse.text();
      if (Buffer.byteLength(upstreamBody, 'utf8') > MAX_RESPONSE_BYTES) {
        jsonResponse(response, 502, { ok: false, error: 'API response was too large.' }, config.portalOrigin);
        return;
      }

      let result;
      try {
        result = JSON.parse(upstreamBody);
      } catch {
        jsonResponse(response, 502, { ok: false, error: 'API returned an invalid response.' }, config.portalOrigin);
        return;
      }

      if (!upstreamResponse.ok) {
        jsonResponse(response, 502, { ok: false, error: 'API request could not be completed.' }, config.portalOrigin);
        return;
      }
      jsonResponse(response, 200, result, config.portalOrigin);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (!error.statusCode || error.statusCode >= 500) {
        console.error('Apps Script proxy request failed:', error.message);
      }
      jsonResponse(
        response,
        error.statusCode || 502,
        { ok: false, error: error.statusCode === 413 ? 'Request body too large.' : 'API request could not be completed.' },
        config.portalOrigin
      );
    }
  });
}

if (require.main === module) {
  const server = createServer({
    upstreamUrl: process.env.APPS_SCRIPT_WEB_APP_URL,
    portalOrigin: process.env.PORTAL_ORIGIN
  });
  const port = Number(process.env.PORT || 10000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`Nile Flow API proxy listening on port ${port}`);
  });
}

module.exports = { createServer };
