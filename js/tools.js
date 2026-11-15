// 그리기 도구: 추세선 · 수평선 · 사각형 · 피보나치 · 롱/숏 포지션 · 자. 심볼별로 localStorage에 저장.
// 좌표는 {time(초), price}로 보관하므로 타임프레임을 바꿔도 같은 위치에 남는다.
(function (root) {
  const ET = (root.ET = root.ET || {});

  // 봉 번호 ↔ 시각. 데이터 범위 밖(미래/과거)은 봉 간격으로 외삽한다.
  const geo = (ET.geo = {
    idxToTime(S, i) {
      const c = S.candles, n = c.length;
      if (!n) return 0;
      if (i >= n) return c[n - 1].time + (i - (n - 1)) * S.tfSec;
      if (i < 0) return c[0].time + i * S.tfSec;
      return c[i].time;
    },
    timeToIdx(S, t) {
      const c = S.candles, n = c.length;
      if (!n) return 0;
      if (t >= c[n - 1].time) return n - 1 + (t - c[n - 1].time) / S.tfSec;
      if (t < c[0].time) return (t - c[0].time) / S.tfSec;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].time <= t) lo = mid; else hi = mid - 1; }
      return lo;
    },
    // 포지션 도구: p1=진입, p2=손절 거리. 익절은 손익비 2:1 지점.
    position(d) {
      const entry = d.p1.price, dist = Math.abs(d.p2.price - entry), s = d.type === 'long' ? 1 : -1;
      return { entry, stop: entry - s * dist, tp: entry + s * dist * 2, rr: 2 };
    },
    FIB: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618],
    // 0 = 두 번째 점(파동 끝), 1 = 첫 번째 점(파동 시작), 1.618 = 끝 방향 확장
    fibPrice(d, L) { return L <= 1 ? d.p2.price + (d.p1.price - d.p2.price) * L : d.p2.price - (d.p1.price - d.p2.price) * (L - 1); },
  });

  const TWO_POINT = { trend: 1, rect: 1, fib: 1, long: 1, short: 1, ruler: 1 };

  ET.tools = {
    init(o) {
      const S = o.S, chart = o.chart, series = o.series, el = o.el, ts = chart.timeScale();
      S.tool = 'cursor'; S.pending = null; S.preview = null; S.selected = null; S.drawings = S.drawings || [];
      const changed = () => { o.save(); o.refresh(); };
      const paneW = () => el.clientWidth - chart.priceScale('right').width();
      const paneH = () => chart.panes()[0].getHeight();
      const X = (p) => ts.logicalToCoordinate(geo.timeToIdx(S, p.time));
      const Y = (p) => series.priceToCoordinate(p);

      function point(x, y) {
        const lg = ts.coordinateToLogical(x);
        let price = series.coordinateToPrice(y);
        if (lg == null || price == null) return null;
        const i = Math.round(lg), c = S.candles[i];
        if (c && S.magnet) {
          let best = 15;
          for (const v of [c.open, c.high, c.low, c.close]) { const py = Y(v); if (py != null && Math.abs(py - y) < best) { best = Math.abs(py - y); price = v; } }
        }
        return { time: geo.idxToTime(S, i), price, idx: i };
      }

      function hit(x, y) {
        for (let k = S.drawings.length - 1; k >= 0; k--) {
          const d = S.drawings[k], x1 = X(d.p1), y1 = Y(d.p1.price);
          if (x1 == null || y1 == null) continue;
          if (d.type === 'hline') { if (Math.abs(y - y1) < 6) return d; continue; }
          const x2 = X(d.p2), y2 = Y(d.p2.price);
          if (x2 == null || y2 == null) continue;
          if (d.type === 'trend' || d.type === 'ruler') {
            const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len));
            if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < 6) return d;
            continue;
          }
          let xa = Math.min(x1, x2), xb = Math.max(x1, x2), ya = Math.min(y1, y2), yb = Math.max(y1, y2);
          if (d.type === 'fib') { xb = Infinity; const e = Y(geo.fibPrice(d, 1.618)); if (e != null) { ya = Math.min(ya, e); yb = Math.max(yb, e); } }
          if (d.type === 'long' || d.type === 'short') { const p = geo.position(d), a = Y(p.tp), b = Y(p.stop); if (a == null || b == null) continue; ya = Math.min(a, b); yb = Math.max(a, b); xb = Math.max(xb, xa + 70); }
          if (x >= xa - 4 && x <= xb + 4 && y >= ya - 4 && y <= yb + 4) return d;
        }
        return null;
      }

      function click(x, y) {
        const p = point(x, y);
        if (!p) return;
        const tool = S.tool;
        if (tool === 'cursor') { const d = hit(x, y); S.selected = d ? d.id : null; o.refresh(); return; }
        if (tool === 'wave') { o.onWave(p); return; }
        const mk = (p1, p2) => { const d = { id: Date.now() + Math.random(), type: tool, p1: { time: p1.time, price: p1.price } }; if (p2) d.p2 = { time: p2.time, price: p2.price }; S.drawings.push(d); S.selected = d.id; };
        if (tool === 'hline') mk(p);
        else if (TWO_POINT[tool]) {
          if (!S.pending) { S.pending = p; S.preview = { type: tool, p1: p, p2: p }; o.refresh(); return; }
          mk(S.pending, p);
        }
        S.pending = S.preview = null;
        api.setTool('cursor');
        changed();
      }

      let down = null;
      el.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
      el.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved > 5) return; // 드래그(차트 이동)는 클릭으로 치지 않는다
        const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (x < 0 || x > paneW() || y < 0 || y > paneH()) return;
        click(x, y);
      });
      el.addEventListener('pointermove', (e) => {
        if (!S.pending) return;
        const r = el.getBoundingClientRect(), p = point(e.clientX - r.left, e.clientY - r.top);
        if (p) { S.preview = { type: S.tool, p1: S.pending, p2: p }; o.refresh(); }
      });
      document.addEventListener('keydown', (e) => {
        if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.key === 'Escape') { S.pending = S.preview = null; S.selected = null; api.setTool('cursor'); o.refresh(); }
        if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected != null) api.removeSelected();
      });

      const api = {
        setTool(t) { S.tool = t; S.pending = S.preview = null; el.style.cursor = t === 'cursor' ? '' : 'crosshair'; o.onTool && o.onTool(t); },
        removeSelected() { if (S.selected == null) return false; S.drawings = S.drawings.filter((d) => d.id !== S.selected); S.selected = null; changed(); return true; },
        clearAll() { S.drawings = []; S.selected = null; changed(); },
        click, // 테스트용
      };
      return api;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
