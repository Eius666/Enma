// Vercel Edge Middleware — HTTP Basic Auth for /admin/* paths
// Runs at the CDN edge before any static file is served.
// Enabled only when ADMIN_HTTP_USER + ADMIN_HTTP_PASS env vars are set.

export const config = {
  matcher: ['/admin', '/admin/:path*'],
};

export default function middleware(request: Request): Response | undefined {
  const user = process.env.ADMIN_HTTP_USER;
  const pass = process.env.ADMIN_HTTP_PASS;

  // If env vars are not configured, skip Basic Auth (fall through to React app)
  if (!user || !pass) return undefined;

  const auth = request.headers.get('authorization') ?? '';

  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const sep     = decoded.indexOf(':');
      const u       = decoded.slice(0, sep);
      const p       = decoded.slice(sep + 1);
      if (u === user && p === pass) return undefined;
    } catch {
      // malformed base64 — fall through to 401
    }
  }

  return new Response('401 Unauthorized — Enma Admin', {
    status:  401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Enma Admin", charset="UTF-8"',
      'Content-Type':     'text/plain; charset=utf-8',
    },
  });
}
