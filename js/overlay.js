// 캔들 시리즈에 붙는 Lightweight Charts 프리미티브. 모든 오버레이를 캔버스에 직접 그린다.
(function (root) {
  const ET = (root.ET = root.ET || {});

  const STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const PALETTE = [];
  for (let i = 0; i < 32; i++) {
    const f = (i / 31) * (STOPS.length - 1), a = Math.floor(f), b = Math.min(STOPS.length - 1, a + 1), r = f - a;
    const ch = (k) => Math.round(STOPS[a][k] + (STOPS[b][k] - STOPS[a][k]) * r);
    PALETTE.push('rgba(' + ch(0) + ',' + ch(1) + ',' + ch(2) + ',' + (0.10 + 0.75 * (i / 31)).toFixed(2) + ')');
  }
  const TIER_LONG = ['#7a2a35', '#b33a48', '#e0525f', '#ff8a8f'];
  const TIER_SHORT = ['#1f6b57', '#2a9477', '#3cc49b', '#86ecc9'];
  const fmtUsd = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0));

  class Overlay {
    constructor(state) {
      this.S = state; // app.js의 공유 상태
      this._colKey = '';
      this._cols = null;
      const self = this;
      const view = (z, fn) => ({ zOrder: () => z, renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace((scope) => { try { fn.call(self, scope.context, scope.mediaSize); } catch (e) { console.error(e); } }) }) });
      this._views = [view('bottom', this.drawHeatmap), view('top', this.drawTop)];
    }
    attached(p) { this.chart = p.chart; this.series = p.series; this._req = p.requestUpdate; }
    detached() {}
    updateAllViews() {}
    paneViews() { return this._views; }
    refresh() { if (this._req) this._req(); }

    _geom(size) {
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange();
      if (!r) return null;
      const bs = ts.options().barSpacing;
      const from = Math.floor(r.from) - 1, to = Math.ceil(r.to) + 1;
      const x0 = ts.logicalToCoordinate(from);
      if (x0 == null) return null;
      return { from, to, bs, x: (i) => x0 + (i - from) * bs, y: (p) => this.series.priceToCoordinate(p), w: size.width, h: size.height };
    }

    // 표시 봉 → 청산맵 기준 열 매핑
    _columns() {
      const S = this.S, m = S.liq, c = S.candles;
      const key = m.times[0] + ':' + m.T + ':' + (c.length ? c[0].time + ':' + c.length : '') + ':' + S.tfSec;
      if (key === this._colKey) return this._cols;
      const cols = new Int32Array(c.length);
      const adj = S.tfSec > m.stepSec ? S.tfSec - m.stepSec : 0;
      for (let i = 0; i < c.length; i++) {
        let k = Math.floor((c[i].time + adj - m.times[0]) / m.stepSec);
        if (k >= m.T && c[i].time <= m.times[m.T - 1] + m.stepSec) k = m.T - 1;
        cols[i] = k >= 0 && k < m.T ? k : -1;
      }
      this._colKey = key; this._cols = cols;
      return cols;
    }

    drawHeatmap(ctx, size) {
      const S = this.S, m = S.liq;
      if (!m || !S.on.heatmap || !S.candles.length) return;
      const g = this._geom(size);
      if (!g) return;
      const cols = this._columns();
      const a = Math.max(0, g.from), b = Math.min(S.candles.length - 1, g.to);
      if (b < a) return;
      const pTop = this.series.coordinateToPrice(0), pBot = this.series.coordinateToPrice(g.h);
      if (pTop == null || pBot == null) return;
      const b0 = Math.max(0, Math.floor((pBot - m.min) / m.step)), b1 = Math.min(m.n - 1, Math.floor((pTop - m.min) / m.step));
      const scale = S.intensity / m.vmax;
      const step = g.bs < 1 ? Math.ceil(1 / g.bs) : 1;
      for (let r = b0; r <= b1; r++) {
        const y1 = g.y(m.min + r * m.step), y2 = g.y(m.min + (r + 1) * m.step);
        if (y1 == null || y2 == null) continue;
        const hgt = Math.max(1, y1 - y2);
        let runStart = -1, runBucket = -1;
        for (let i = a; i <= b + 1; i += step) {
          let bucket = -1;
          if (i <= b && cols[i] >= 0) {
            const v = m.grid[cols[i] * m.n + r];
            if (v > 0) { const nrm = Math.min(1, Math.pow(v * scale, 0.8)); if (nrm >= 0.12) bucket = Math.round(nrm * 31); }
          }
          if (bucket !== runBucket) {
            if (runBucket >= 0) { ctx.fillStyle = PALETTE[runBucket]; ctx.fillRect(g.x(runStart) - g.bs / 2, y2, (i - runStart) * g.bs, hgt); }
            runStart = i; runBucket = bucket;
          }
        }
        // 현재 남아 있는 레벨은 마지막 봉 오른쪽 여백까지 연장
        const v = m.grid[(m.T - 1) * m.n + r];
        if (v > 0) {
          const nrm = Math.min(1, Math.pow(v * scale, 0.8));
          const xe = g.x(S.candles.length - 1) + g.bs / 2;
          if (nrm >= 0.12 && xe < g.w) { ctx.fillStyle = PALETTE[Math.round(nrm * 31)]; ctx.fillRect(xe, y2, g.w - xe, hgt); }
        }
      }
    }

    drawTop(ctx, size) {
      const S = this.S;
      if (!S.candles.length) return;
      const g = this._geom(size);
      if (!g) return;
      ctx.save();
      ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      if (S.smc) this.drawSmc(ctx, g);
      if (S.on.liqs) this.drawLiqs(ctx, g);
      if (S.on.ewAuto && S.ew) this.drawWave(ctx, g, S.ew.labels, S.ew, '#f5c542');
      if (S.manual.length) this.drawWave(ctx, g, S.manualLabels, S.manualInfo, '#4fc3f7');
      if (S.on.profile && S.liq) this.drawProfile(ctx, g);
      ctx.restore();
    }

    drawSmc(ctx, g) {
      const S = this.S, s = S.smc, last = S.candles.length - 1;
      const vis = (i1, i2) => i2 >= g.from && i1 <= g.to;
      const box = (i1, i2, top, bottom, fill, stroke, label) => {
        const x1 = g.x(i1) - g.bs / 2, x2 = i2 == null ? g.w : g.x(i2) + g.bs / 2, y1 = g.y(top), y2 = g.y(bottom);
        if (y1 == null || y2 == null) return;
        ctx.fillStyle = fill; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1, y2 - y1); }
        if (label) { ctx.fillStyle = stroke || fill; ctx.textAlign = 'left'; ctx.fillText(label, Math.max(x1, 2) + 3, (y1 + y2) / 2); }
      };
      if (S.on.fvg) {
        // 미충족 FVG 전부 + 최근에 메워진 것 일부
        for (const f of s.fvgs) {
          if (f.endIdx != null && f.endIdx < last - 300) continue;
          if (!vis(f.idx, f.endIdx == null ? Infinity : f.endIdx)) continue;
          const open = f.endIdx == null;
          box(f.idx, f.endIdx, f.top, f.bottom, f.dir === 1 ? (open ? 'rgba(38,166,154,0.22)' : 'rgba(38,166,154,0.07)') : (open ? 'rgba(239,83,80,0.22)' : 'rgba(239,83,80,0.07)'), null, open ? 'FVG' : '');
        }
      }
      if (S.on.ob) {
        const live = s.obs.filter((o) => o.endIdx == null).slice(-8);
        for (const o of live) {
          if (!vis(o.idx, Infinity)) continue;
          box(o.idx, null, o.top, o.bottom, o.dir === 1 ? 'rgba(41,98,255,0.16)' : 'rgba(255,152,0,0.16)', o.dir === 1 ? 'rgba(41,98,255,0.8)' : 'rgba(255,152,0,0.8)', o.dir === 1 ? '+OB' : '-OB');
        }
      }
      if (S.on.structure) {
        ctx.lineWidth = 1;
        for (const st of s.structures) {
          if (!vis(st.fromIdx, st.toIdx)) continue;
          const y = g.y(st.price);
          if (y == null) continue;
          const col = st.dir === 1 ? '#26a69a' : '#ef5350';
          ctx.strokeStyle = col; ctx.setLineDash(st.type === 'CHoCH' ? [5, 3] : []);
          ctx.beginPath(); ctx.moveTo(g.x(st.fromIdx), y + 0.5); ctx.lineTo(g.x(st.toIdx), y + 0.5); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = col; ctx.textAlign = 'center';
          ctx.fillText(st.type, (g.x(st.fromIdx) + g.x(st.toIdx)) / 2, y + (st.dir === 1 ? -8 : 9));
        }
        ctx.fillStyle = 'rgba(200,205,215,0.75)'; ctx.textAlign = 'center';
        for (const sw of s.swings) {
          if (sw.idx < g.from || sw.idx > g.to) continue;
          const y = g.y(sw.price);
          if (y != null) ctx.fillText(sw.label, g.x(sw.idx), y + (sw.type === 'H' ? -9 : 10));
        }
      }
      if (S.on.eq) {
        ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        for (const e of s.eq) {
          if (e.endIdx != null && e.endIdx < last - 300) continue;
          if (!vis(e.i1, e.endIdx == null ? Infinity : e.endIdx)) continue;
          const y = g.y(e.price);
          if (y == null) continue;
          const open = e.endIdx == null, col = e.type === 'EQH' ? '#ef5350' : '#26a69a';
          ctx.globalAlpha = open ? 1 : 0.4;
          ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(g.x(e.i1), y + 0.5); ctx.lineTo(open ? g.w : g.x(e.endIdx), y + 0.5); ctx.stroke();
          ctx.fillStyle = col; ctx.textAlign = 'left';
          ctx.fillText(e.type + (open ? ' $$$' : ' 스윕'), g.x(e.i2) + 4, y + (e.type === 'EQH' ? -8 : 9));
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash([]);
      }
      if (S.on.pd && s.range) {
        const yh = g.y(s.range.high), yl = g.y(s.range.low), ye = g.y(s.range.eq), x1 = g.x(s.range.fromIdx);
        if (yh != null && yl != null && ye != null) {
          ctx.fillStyle = 'rgba(239,83,80,0.05)'; ctx.fillRect(x1, yh, g.w - x1, ye - yh);
          ctx.fillStyle = 'rgba(38,166,154,0.05)'; ctx.fillRect(x1, ye, g.w - x1, yl - ye);
          ctx.strokeStyle = 'rgba(200,205,215,0.5)'; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(x1, ye + 0.5); ctx.lineTo(g.w, ye + 0.5); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(200,205,215,0.8)'; ctx.textAlign = 'left';
          ctx.fillText('프리미엄', x1 + 4, yh + 9); ctx.fillText('EQ 50%', x1 + 4, ye - 8); ctx.fillText('디스카운트', x1 + 4, yl - 9);
        }
      }
    }

    drawLiqs(ctx, g) {
      const S = this.S, c = S.candles;
      for (const e of S.liqEvents) {
        if (e.usd < S.minLiqUsd) continue;
        let lo = 0, hi = c.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].time <= e.t) lo = mid; else hi = mid - 1; }
        if (c[lo].time > e.t || lo < g.from || lo > g.to) continue;
        const y = g.y(e.price);
        if (y == null) continue;
        const r = Math.max(3, Math.min(26, Math.sqrt(e.usd / 1000) * 0.9));
        ctx.beginPath(); ctx.arc(g.x(lo), y, r, 0, Math.PI * 2);
        ctx.fillStyle = e.side === 'long' ? 'rgba(239,83,80,0.35)' : 'rgba(38,166,154,0.35)';
        ctx.strokeStyle = e.side === 'long' ? '#ef5350' : '#26a69a';
        ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
      }
    }

    drawWave(ctx, g, labels, info, color) {
      if (!labels || !labels.length) return;
      const pts = labels.map((l) => ({ x: g.x(l.idx), y: g.y(l.price), l })).filter((p) => p.y != null);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.textAlign = 'center';
      const dir = info ? info.dir : 1;
      pts.forEach((p, i) => {
        const up = (i % 2 === 1) === (dir === 1); // 고점이면 위쪽에 라벨
        const ly = p.y + (up ? -16 : 16);
        ctx.beginPath(); ctx.arc(p.x, ly, 9, 0, Math.PI * 2);
        ctx.fillStyle = p.l.provisional ? 'rgba(20,23,31,0.9)' : color; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = p.l.provisional ? color : '#14171f';
        ctx.font = 'bold 11px -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(p.l.text, p.x, ly + 0.5);
      });
      ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
      if (!info) return;
      const xl = pts.length ? pts[pts.length - 1].x : 0;
      const hline = (price, text, col, dash) => {
        const y = g.y(price);
        if (y == null) return;
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(xl, y + 0.5); ctx.lineTo(g.w, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.textAlign = 'right';
        ctx.fillText(text + ' ' + price.toFixed(1), g.w - (this.S.on.profile ? g.w * 0.2 : 6), y - 7);
      };
      if (info.invalidation) hline(info.invalidation.price, '무효화', '#ff5252', [6, 3]);
      for (const t of info.targets || []) hline(t.price, t.label, color, [2, 4]);
    }

    // 코인글래스식 청산맵(가격대별 막대 + 누적선)을 차트 오른쪽에 겹쳐 그린다.
    drawProfile(ctx, g) {
      const S = this.S, m = S.liq, price = S.candles[S.candles.length - 1].close;
      const p = ET.liqmap.profile(m, price);
      const pTop = this.series.coordinateToPrice(0), pBot = this.series.coordinateToPrice(g.h);
      if (pTop == null || pBot == null) return;
      const b0 = Math.max(0, Math.floor((pBot - m.min) / m.step)), b1 = Math.min(m.n - 1, Math.floor((pTop - m.min) / m.step));
      let vmax = 0, cmax = 0;
      for (let b = b0; b <= b1; b++) { vmax = Math.max(vmax, p.long[b], p.short[b]); cmax = Math.max(cmax, p.cumLong[b], p.cumShort[b]); }
      if (!vmax) return;
      const W = g.w * 0.18, nt = m.tiers.length;
      for (let b = b0; b <= b1; b++) {
        const side = p.long[b] > 0 ? 0 : p.short[b] > 0 ? 1 : -1;
        if (side < 0) continue;
        const y1 = g.y(m.min + b * m.step), y2 = g.y(m.min + (b + 1) * m.step);
        if (y1 == null || y2 == null) continue;
        let x = g.w;
        for (let t = 0; t < nt; t++) {
          const w = (m.active[side][t][b] / vmax) * W;
          if (w <= 0) continue;
          ctx.fillStyle = (side === 0 ? TIER_LONG : TIER_SHORT)[t % 4];
          ctx.fillRect(x - w, y2, w, Math.max(1, y1 - y2 - 0.5));
          x -= w;
        }
      }
      const curve = (arr, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        for (let b = b0; b <= b1; b++) {
          if (arr[b] <= 0) continue;
          const y = g.y(m.min + (b + 0.5) * m.step), x = g.w - (arr[b] / cmax) * W;
          if (y == null) continue;
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
        }
        ctx.stroke();
      };
      curve(p.cumLong, '#ff8a8f'); curve(p.cumShort, '#86ecc9');
      ctx.textAlign = 'right'; ctx.fillStyle = '#86ecc9';
      ctx.fillText('숏 청산 누적 $' + fmtUsd(p.totalShort), g.w - 6, 12);
      ctx.fillStyle = '#ff8a8f';
      ctx.fillText('롱 청산 누적 $' + fmtUsd(p.totalLong), g.w - 6, g.h - 10);
    }
  }

  ET.Overlay = Overlay;
  ET.fmtUsd = fmtUsd;
})(typeof window !== 'undefined' ? window : globalThis);
