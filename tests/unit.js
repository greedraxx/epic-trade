// node tests/unit.js — 분석 로직 단위 테스트 (합성 데이터)
const assert = require('assert');
require('../js/liqmap.js');
require('../js/smc.js');
require('../js/elliott.js');
require('../js/signal.js');
const { liqmap, smc, elliott, signal } = globalThis.ET;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
// 꼭짓점 가격 목록을 봉으로 펼친다 (각 구간 steps봉 직선 이동)
function path(points, steps) {
  const out = [];
  let t = 0;
  for (let i = 1; i < points.length; i++) {
    for (let s = 1; s <= steps; s++) {
      const a = points[i - 1] + ((points[i] - points[i - 1]) * (s - 1)) / steps, b = points[i - 1] + ((points[i] - points[i - 1]) * s) / steps;
      out.push(bar((t += 60), a, Math.max(a, b) + 0.5, Math.min(a, b) - 0.5, b));
    }
  }
  return out;
}

test('liqmap: OI 증가 → 양방향 레벨 생성, 청산가 공식', () => {
  const k = [], oi = [];
  for (let i = 0; i < 10; i++) { k.push(bar(i * 300, 100000, 100050, 99950, 100000)); oi.push({ time: i * 300, oi: 1000 }); }
  oi.push({ time: 3000, oi: 1000 });
  oi[4].oi = 1100; for (let i = 5; i < oi.length; i++) oi[i].oi = 1100; // 3번 봉 동안 +100 BTC
  const m = liqmap.compute(k, oi, { tiers: [{ lev: 10, w: 1 }], mmr: 0.005 });
  const entry = (100050 + 99950 + 100000) / 3;
  const bl = Math.floor((entry * (1 - 0.1 + 0.005) - m.min) / m.step), bs = Math.floor((entry * (1 + 0.1 - 0.005) - m.min) / m.step);
  assert.ok(Math.abs(m.active[0][0][bl] - 100 * entry) < 1, 'long level');
  assert.ok(Math.abs(m.active[1][0][bs] - 100 * entry) < 1, 'short level');
  assert.strictEqual(m.grid[2 * m.n + bl], 0, '생성 전에는 0');
  assert.ok(m.grid[3 * m.n + bl] > 0, '생성 봉부터 표시');
});

test('liqmap: 가격이 지나가면 소멸, OI 감소 시 비례 축소', () => {
  const k = [], oi = [];
  for (let i = 0; i < 10; i++) { k.push(bar(i * 300, 100000, 100050, 99950, 100000)); oi.push({ time: i * 300, oi: i >= 2 ? 1100 : 1000 }); }
  oi.push({ time: 3000, oi: 1100 });
  oi[6].oi = 550; for (let i = 7; i < oi.length; i++) oi[i].oi = 550; // 5번 봉에서 절반으로
  k[8] = bar(8 * 300, 100000, 100050, 90000, 99000); // 롱 청산 레벨(약 90,500) 스윕
  const m = liqmap.compute(k, oi, { tiers: [{ lev: 10, w: 1 }] });
  const entry = 100000, bl = Math.floor((entry * 0.905 - m.min) / m.step), bs = Math.floor((entry * 1.095 - m.min) / m.step);
  assert.ok(Math.abs(m.grid[5 * m.n + bs] / m.grid[4 * m.n + bs] - 0.5) < 1e-6, '절반 축소');
  assert.ok(m.grid[7 * m.n + bl] > 0 && m.grid[8 * m.n + bl] === 0, '스윕 후 롱 레벨 제거');
  assert.ok(m.active[1][0][bs] > 0, '숏 레벨은 유지');
  const cl = liqmap.clusters(m, 99000, 3);
  assert.strictEqual(cl.long.length, 0);
  assert.ok(cl.short[0].dist > 0);
});

test('liqmap: 여러 거래소는 같은 구간에 달러 금액 그대로 합산, 거래소별 MMR 적용', () => {
  const mk = (oiAdd) => { const k = [], oi = []; for (let i = 0; i < 10; i++) { k.push(bar(i * 300, 100000, 100050, 99950, 100000)); oi.push({ time: i * 300, oi: i >= 4 ? 1000 + oiAdd : 1000 }); } oi.push({ time: 3000, oi: 1000 + oiAdd }); return { k, oi }; };
  const a = mk(100), b = mk(300), tiers = [{ lev: 10, w: 1 }];
  const m = liqmap.computeMulti([{ id: 'A', klines: a.k, oi: a.oi, mmr: 0.005 }, { id: 'B', klines: b.k.slice(2), oi: b.oi, mmr: 0.004 }], { tiers });
  const one = liqmap.compute(a.k, a.oi, { tiers, mmr: 0.005 });
  assert.strictEqual(m.sources.length, 2);
  assert.ok(Math.abs(m.sources[1].usd / m.sources[0].usd - 3) < 1e-9, 'OI 증가분에 비례');
  const sum = (x) => { let v = 0; for (let b2 = 0; b2 < x.n; b2++) v += x.active[0][0][b2] + x.active[1][0][b2]; return v; };
  assert.ok(Math.abs(sum(m) - 4 * sum(one)) < 1, '합계 = 두 거래소의 합');
  const entry = (100050 + 99950 + 100000) / 3;
  const binA = Math.floor((entry * 0.905 - m.min) / m.step), binB = Math.floor((entry * 0.904 - m.min) / m.step);
  assert.ok(binA !== binB && m.active[0][0][binA] > 0 && m.active[0][0][binB] > 0, 'MMR이 다르면 청산가 구간도 다름');
  assert.ok(Math.abs(m.sources[0].oiUsd - 1100 * 100000) < 1);
  assert.strictEqual(liqmap.computeMulti([{ id: 'X', klines: [], oi: [] }]), null, '데이터 없는 거래소만 있으면 null');
});

test('smc: 상승 BOS → 하락 전환 CHoCH, 오더블록 생성', () => {
  const c = path([100, 120, 110, 135, 122, 150, 140, 143, 105], 12);
  const s = smc.analyze(c, { len: 3 });
  const types = s.structures.map((x) => x.type + (x.dir === 1 ? '+' : '-'));
  assert.ok(types.includes('BOS+'), types.join(','));
  assert.strictEqual(types[types.length - 1], 'CHoCH-');
  assert.strictEqual(s.trend, -1);
  for (const st of s.structures) assert.ok(st.toIdx > st.fromIdx);
  assert.ok(s.obs.some((o) => o.dir === 1) && s.obs.some((o) => o.dir === -1));
  // 리페인트 없음: 뒤 봉을 잘라내도 그 시점까지의 구조 신호는 동일해야 한다
  const cut = smc.analyze(c.slice(0, 70), { len: 3 });
  const a = s.structures.filter((x) => x.toIdx < 70).map((x) => x.type + x.toIdx), b = cut.structures.map((x) => x.type + x.toIdx);
  assert.deepStrictEqual(a, b);
});

test('smc: FVG 생성과 메움', () => {
  const c = [];
  for (let i = 0; i < 20; i++) c.push(bar(i * 60, 100, 101, 99, 100));
  c.push(bar(1200, 100, 110, 100, 110)); // 장대 양봉
  c.push(bar(1260, 110, 112, 108, 111)); // 저가 108 > 2봉 전 고가 101 → 상승 FVG [101,108]
  c.push(bar(1320, 111, 112, 109, 110));
  let s = smc.analyze(c, { len: 3 });
  const f = s.fvgs.find((x) => x.dir === 1);
  assert.ok(f && f.bottom === 101 && f.top === 108 && f.endIdx == null);
  c.push(bar(1380, 110, 110, 100.5, 102)); // 완전히 메움
  s = smc.analyze(c, { len: 3 });
  assert.ok(s.fvgs.find((x) => x.dir === 1).endIdx === c.length - 1);
});

test('smc: EQH 감지', () => {
  const c = path([100, 120, 110, 120.2, 108, 112], 10);
  const s = smc.analyze(c, { len: 3, eqAtr: 0.5 });
  assert.ok(s.eq.some((e) => e.type === 'EQH'), JSON.stringify(s.eq));
});

test('elliott: 규칙 검증', () => {
  assert.deepStrictEqual(elliott.validate([100, 120, 110, 150, 130, 160], 1, false), []);
  assert.ok(elliott.validate([100, 120, 95, 150], 1, false).some((v) => v.includes('2파')));
  assert.ok(elliott.validate([100, 120, 110, 150, 118, 160], 1, false).some((v) => v.includes('4파')));
  assert.ok(elliott.validate([100, 130, 115, 135, 131, 170], 1, false).some((v) => v.includes('가장 짧음')));
  assert.deepStrictEqual(elliott.validate([200, 180, 190, 150, 170, 140], -1, false), []); // 하락 충격
  assert.deepStrictEqual(elliott.validate([100, 120, 110, 115], 1, true), [], '진행 중인 3파는 아직 1파 고점을 못 넘어도 위반 아님');
});

test('elliott: 목표/무효화', () => {
  const p = elliott.project([100, 120, 110, 150, 135], 1, false); // 5파 예상
  assert.strictEqual(p.invalidation.price, 135);
  assert.ok(p.targets.some((t) => Math.abs(t.price - 155) < 1e-9)); // 135 + 20
  const q = elliott.project([200, 180, 190], -1, false); // 하락 3파 예상
  assert.strictEqual(q.invalidation.price, 190);
  assert.ok(q.targets.some((t) => Math.abs(t.price - (190 - 20 * 1.618)) < 1e-9));
});

test('elliott: 합성 5파에서 자동 카운트가 1~4를 맞게 찾는다', () => {
  const c = path([1000, 1200, 1100, 1500, 1350, 1450], 30);
  const e = elliott.auto(c, smc.atr(c, 14), { mult: 4 });
  assert.ok(e, 'count found');
  assert.strictEqual(e.dir, 1);
  const prices = e.labels.map((l) => Math.round(l.price / 10) * 10);
  assert.deepStrictEqual(prices.slice(0, 5), [1000, 1200, 1100, 1500, 1350]);
  assert.strictEqual(e.labels[e.labels.length - 1].provisional, true);
  assert.ok(e.stage.startsWith('5파'));
});

test('elliott: 수동 카운트 위반 보고', () => {
  const m = elliott.manual([{ price: 100 }, { price: 120 }, { price: 90 }]);
  assert.strictEqual(m.dir, 1);
  assert.ok(m.violations.length > 0);
});

test('signal: 미래 정보를 쓰지 않는다 (뒤 봉을 잘라도 과거 점수 동일)', () => {
  const c = path([100, 130, 115, 150, 120, 160, 140, 170, 125], 25);
  const run = (cc) => { const s = smc.analyze(cc.slice(0, -1), { len: 3 }); return signal.analyze(cc, { atr: smc.atr(cc, 14), structures: s.structures, oiAt: (t) => 1000 + t / 60, liqAsym: (i) => Math.sin(i) }); };
  const full = run(c), cut = run(c.slice(0, 120));
  for (let i = 0; i < 118; i++) assert.ok((isNaN(full.score[i]) && isNaN(cut.score[i])) || Math.abs(full.score[i] - cut.score[i]) < 1e-12, 'bar ' + i);
  assert.strictEqual(full.now.parts.length, 5);
});

test('signal: 적중률 계산 — 완벽한 예측은 100%, 반대 예측은 0%, 수수료 차감', () => {
  const c = path([100, 200], 100), up = new Float64Array(c.length).fill(1), dn = new Float64Array(c.length).fill(-1);
  const a = signal.evaluate(c, up, 4, 0.25, 0.001, c.length - 2), b = signal.evaluate(c, dn, 4, 0.25, 0.001, c.length - 2);
  assert.strictEqual(a.hit, 1); assert.strictEqual(b.hit, 0);
  assert.ok(Math.abs(a.avg - a.net - 0.001) < 1e-12 && b.net < 0 && a.edge && !b.edge);
  assert.strictEqual(a.nEff, Math.round(a.n / 4), '겹치는 구간은 유효 표본을 줄여서 계산');
  assert.strictEqual(signal.evaluate(c, new Float64Array(c.length).fill(0.1), 4, 0.25, 0, c.length - 2).n, 0, '임계값 미만은 신호 없음');
});

console.log('\n' + n + ' tests passed');
