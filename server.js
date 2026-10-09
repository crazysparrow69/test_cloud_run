const http = require('http');

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '0.0.0.0');
