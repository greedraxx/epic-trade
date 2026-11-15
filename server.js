// 의존성 없는 로컬 서버: 정적 파일 + Bybit 공개 REST 프록시(/bybit/*).
// index.html을 더블클릭으로 열었을 때 브라우저가 Bybit 호출을 막으면 이걸 쓴다.
//   node server.js  →  http://localhost:8787
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http
  .createServer((req, res) => {
    if (req.url.startsWith('/bybit/v5/market/')) {
      // 공개 시장 데이터 경로만 중계한다.
      const up = https.get({ host: 'api.bybit.com', path: req.url.slice('/bybit'.length), headers: { accept: 'application/json' } }, (r) => {
        res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
        r.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ retCode: -1, retMsg: e.message })); });
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(ROOT, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log('Epic Trade → http://localhost:' + PORT));
