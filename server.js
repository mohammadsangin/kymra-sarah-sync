const http = require('http');
const { execSync } = require('child_process');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    try {
      console.log('Sync triggered at', new Date().toISOString());
      const output = execSync('node sync-sarah-products.js', {
        timeout: 60000,
        encoding: 'utf8'
      });
      console.log(output);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: 'Sync complete' }));
    } catch (err) {
      console.error(err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
