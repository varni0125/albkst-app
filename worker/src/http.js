// Request and response helpers. CORS is locked to the one origin that is
// allowed to call this Worker.

export function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env) },
  });
}

export function fail(env, status, message, extra = {}) {
  return json(env, { error: message, ...extra }, status);
}

export function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}
