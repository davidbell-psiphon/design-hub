// Same-origin proxy: browser -> Pages (/api/*) -> Worker.
//
// The board used to call the Worker cross-origin. Under Access that cannot
// work: the CF-Authorization cookie is set per hostname, so a cookie for the
// Pages site is not sent to workers.dev; the browser never attaches cookies to
// a CORS preflight, so Access blocks the OPTIONS before it reaches anything;
// and cross-origin that cookie is a third-party cookie, which Safari blocks
// outright — the phone case.
//
// Routing the API through the Pages origin removes all three problems at once.
// No CORS, no preflight, no third-party cookie, one Access application.

const WORKER = 'https://design-hub-worker.d-bell.workers.dev';

const ALLOWED = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);

export async function onRequest(context) {
  const { request, env, params } = context;

  if (!ALLOWED.has(request.method)) {
    return json({ error: 'method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const rest = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const target = `${WORKER}/api/${rest}${url.search}`;

  // Build the outbound headers explicitly. Forwarding the incoming set
  // wholesale would carry the browser's cookies to the Worker, which has no
  // use for them and no business seeing them.
  const headers = new Headers();
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  // Pass the caller's Access identity through so the Worker verifies the human
  // itself rather than trusting this proxy. Access injects this header on the
  // Pages request once the app is enabled; before that it is simply absent.
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (jwt) headers.set('Cf-Access-Jwt-Assertion', jwt);

  // Set these as Pages secrets once the Worker itself is behind Access.
  // Until then they are unset and the call goes through unauthenticated,
  // exactly as it does today.
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
  }
  // The agent secret is never sent from here — this path is for humans.

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }

  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    return json({ error: 'Upstream unreachable: ' + (e && e.message || e) }, 502);
  }

  // If the Worker sits behind Access and this proxy has no service token, the
  // reply is an HTML login page, not JSON. Say so plainly instead of letting
  // the board fail on a parse error it cannot explain.
  const type = res.headers.get('Content-Type') || '';
  if (res.status === 302 || type.includes('text/html')) {
    return json({
      error: 'Blocked by Access. Set CF_ACCESS_CLIENT_ID and ' +
             'CF_ACCESS_CLIENT_SECRET on this Pages project.',
    }, 502);
  }

  const out = new Response(res.body, { status: res.status });
  out.headers.set('Content-Type', type || 'application/json');
  out.headers.set('Cache-Control', 'no-store');
  return out;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
