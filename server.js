const http = require('http');

const port = process.env.PORT || 8080;

const operations = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseNumber(value) {
  if (value === null || value.trim() === '') {
    return NaN;
  }
  return Number(value);
}

function calculate(params, res) {
  const op = params.get('op') || 'add';
  const a = parseNumber(params.get('a'));
  const b = parseNumber(params.get('b'));

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    sendJson(res, 400, { error: 'a and b must be numbers' });
    return;
  }

  if (!Object.hasOwn(operations, op)) {
    sendJson(res, 400, { error: `op must be one of: ${Object.keys(operations).join(', ')}` });
    return;
  }

  if (op === 'div' && b === 0) {
    sendJson(res, 400, { error: 'division by zero' });
    return;
  }

  sendJson(res, 200, { a, b, op, result: operations[op](a, b) });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/calculate') {
    calculate(url.searchParams, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '0.0.0.0');
