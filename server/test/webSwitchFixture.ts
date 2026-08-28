import { createServer, type Server } from 'node:http';

export interface WebSwitchFixture {
  port: number;
  host: string;
  url: string;
  user: string;
  pass: string;
  close: () => Promise<void>;
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/index_css.css">
<script src="/iss/specific/const_common.js"></script>
<title>Login</title></head><body>
<form name="login" method="POST" action="/iss/redirect.html">
<input type="text" name="Login" id="Login">
<input type="password" name="Password" id="Password">
<input type="submit" value="Sign in">
</form></body></html>`;

const MAIN_PAGE = `<!DOCTYPE html><html><head><title>AT-GS950</title>
<link rel="stylesheet" href="/index_css.css">
<script src="/iss/app.js"></script></head>
<body>
<frameset cols="180,*"><frame src="/iss/menu.html" name="menu"><frame src="/iss/home.html" name="body"></frameset>
<a href="/iss/vlan.html">VLANs</a>
<img src="/iss/logo.gif">
<form action="/iss/apply.cgi" method="post"><input name="x"></form>
</body></html>`;

/**
 * A mock Allied Telesis AT-GS950 web GUI for proxy tests: plain HTTP, an HTML
 * login form (POST /iss/redirect.html), a session cookie, and pages under /iss/
 * that 401 without it. HTML carries absolute paths + a frameset to exercise the
 * proxy's rewriting.
 */
export async function startWebSwitchFixture(opts?: { user?: string; pass?: string }): Promise<WebSwitchFixture> {
  const user = opts?.user ?? 'manager';
  const pass = opts?.pass ?? 'friend';
  const SID = 'sid-' + Math.random().toString(36).slice(2);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const authed = (req.headers.cookie ?? '').includes(`SID=${SID}`);

    if (req.method === 'POST' && path === '/iss/redirect.html') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('Login') === user && p.get('Password') === pass) {
          res.writeHead(302, { 'set-cookie': `SID=${SID}; Path=/; HttpOnly`, location: '/iss/main.html' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(LOGIN_PAGE);
        }
      });
      return;
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' });
      res.end(LOGIN_PAGE);
      return;
    }

    if (path.startsWith('/iss/')) {
      if (!authed) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      if (path === '/iss/logo.gif') {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])); // "GIF89a"
        return;
      }
      if (path === '/iss/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('var api="/iss/data.cgi";');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' });
      res.end(MAIN_PAGE);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  return {
    port,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${port}/`,
    user,
    pass,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
