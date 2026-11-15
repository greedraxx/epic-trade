// 의존성 없는 로컬 서버: 정적 파일 + 3대 거래소 공개 REST 프록시(/proxy/<거래소>/*).
// 브라우저가 거래소 REST 직접 호출을 막으면(CORS) 이걸 쓴다.
//   node server.js  →  http://localhost:8787
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const UPSTREAM = {
  bybit: ['api.bybit.com', ['/v5/market/']],
  binance: ['fapi.binance.com', ['/fapi/v1/klines', '/futures/data/openInterestHist']],
  okx: ['www.okx.com', ['/api/v5/market/', '/api/v5/rubik/stat/', '/api/v5/public/instruments']],
};
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http
  .createServer((req, res) => {
    // 공개 시장 데이터 경로만 중계한다: /proxy/<거래소>/<경로>
    const m = req.url.match(/^\/proxy\/(bybit|binance|okx)(\/.*)$/);
    if (m) {
      const [host, allow] = UPSTREAM[m[1]];
      if (!allow.some((p) => m[2].startsWith(p))) { res.writeHead(403); return res.end(); }
      const up = https.get({ host, path: m[2], headers: { accept: 'application/json' } }, (r) => {
        res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
        r.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
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
