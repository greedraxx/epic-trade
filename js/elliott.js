// 엘리엇 파동: ATR 지그재그 피벗 + 절대 규칙 검증.
// 자동 카운트는 "규칙을 위반하지 않는 후보 하나"일 뿐 정답이 아니다. 수동 카운트도 같은 규칙으로 검증한다.
(function (root) {
  const ET = (root.ET = root.ET || {});
  const NAMES = ['0', '1', '2', '3', '4', '5', 'A', 'B', 'C'];

  // 반전 폭 mult×ATR 지그재그. 마지막 피벗은 미확정(provisional).
  function zigzag(c, A, mult) {
    const piv = [];
    if (c.length < 3) return piv;
    let dir = c[Math.min(10, c.length - 1)].close >= c[0].close ? 1 : -1;
    let ext = { idx: 0, price: dir === 1 ? c[0].high : c[0].low };
    for (let i = 1; i < c.length; i++) {
      const thr = mult * A[i];
      if (dir === 1) {
        if (c[i].high > ext.price) ext = { idx: i, price: c[i].high };
        else if (ext.price - c[i].low >= thr) { piv.push({ idx: ext.idx, price: ext.price, type: 'H' }); dir = -1; ext = { idx: i, price: c[i].low }; }
      } else {
        if (c[i].low < ext.price) ext = { idx: i, price: c[i].low };
        else if (c[i].high - ext.price >= thr) { piv.push({ idx: ext.idx, price: ext.price, type: 'L' }); dir = 1; ext = { idx: i, price: c[i].high }; }
      }
    }
    piv.push({ idx: ext.idx, price: ext.price, type: dir === 1 ? 'H' : 'L', provisional: true });
    // 데이터 시작부: 첫 피벗 이전의 반대편 극값을 시작 피벗으로 둔다
    const f = piv[0], seed = { idx: 0, price: f.type === 'H' ? c[0].low : c[0].high, type: f.type === 'H' ? 'L' : 'H' };
    for (let i = 0; i < f.idx; i++) {
      if (f.type === 'H' ? c[i].low < seed.price : c[i].high > seed.price) { seed.idx = i; seed.price = f.type === 'H' ? c[i].low : c[i].high; }
    }
    if (f.idx > 0) piv.unshift(seed);
    return piv;
  }

  // prices: 0,1,2,3,4,5,A,B,C 순서의 가격. dir: 1 상승 충격 / -1 하락 충격.
  // lastOpen=true면 마지막 점은 진행 중인 파동이므로 "도달해야 하는" 조건은 검사하지 않는다.
  function validate(prices, dir, lastOpen) {
    const v = prices.map((p) => p * dir), n = v.length, bad = [];
    const done = (k) => k < n - 1 || !lastOpen; // k번 점이 확정인가
    const sign = [0, 1, -1, 1, -1, 1, -1, 1, -1];
    for (let k = 1; k < n; k++) if ((v[k] - v[k - 1]) * sign[k] <= 0) bad.push(NAMES[k] + '파 방향이 맞지 않음');
    if (n > 2 && v[2] <= v[0]) bad.push('2파가 1파 시작점을 넘어 되돌림 (절대 규칙 위반)');
    if (n > 3 && done(3) && v[3] <= v[1]) bad.push('3파가 1파 끝을 넘지 못함');
    if (n > 4 && v[4] <= v[1]) bad.push('4파가 1파 영역과 겹침 (절대 규칙 위반)');
    if (n > 5 && done(5)) {
      const w1 = v[1] - v[0], w3 = v[3] - v[2], w5 = v[5] - v[4];
      if (w3 < w1 && w3 < w5) bad.push('3파가 가장 짧음 (절대 규칙 위반)');
      if (v[5] <= v[3]) bad.push('5파가 3파 끝을 넘지 못함 (절단형 가능성)');
    }
    if (n > 7 && v[7] >= v[5]) bad.push('B파가 5파 끝을 넘음 (지그재그 아님 — 플랫/추세 연장 가능성)');
    if (n > 8 && done(8) && v[8] >= v[6]) bad.push('C파가 A파 끝을 넘지 못함');
    return bad;
  }

  // 다음 파동의 무효화 레벨과 피보나치 목표
  function project(prices, dir, lastOpen) {
    const P = prices, n = P.length, out = { invalidation: null, targets: [], stage: '' };
    const ext = (from, len, r) => from + dir * len * r;
    const t = (price, label) => out.targets.push({ price, label });
    const open = lastOpen ? n - 1 : n; // 진행 중(또는 다음)인 파동 번호
    out.stage = NAMES[Math.min(open, 8)] + '파 ' + (lastOpen ? '진행 중' : '예상');
    const w1 = n > 1 ? Math.abs(P[1] - P[0]) : 0, w3 = n > 3 ? Math.abs(P[3] - P[2]) : 0;
    if (open === 2) {
      out.invalidation = { price: P[0], reason: '2파는 1파 시작점을 넘을 수 없음' };
      t(ext(P[1], w1, -0.5), '2파 0.5'); t(ext(P[1], w1, -0.618), '2파 0.618');
    } else if (open === 3) {
      out.invalidation = { price: P[2], reason: '2파 끝 이탈 시 이 카운트 폐기' };
      t(ext(P[2], w1, 1.0), '3파 1.0'); t(ext(P[2], w1, 1.618), '3파 1.618'); t(ext(P[2], w1, 2.618), '3파 2.618');
    } else if (open === 4) {
      out.invalidation = { price: P[1], reason: '4파는 1파 영역과 겹칠 수 없음' };
      t(ext(P[3], w3, -0.236), '4파 0.236'); t(ext(P[3], w3, -0.382), '4파 0.382'); t(ext(P[3], w3, -0.5), '4파 0.5');
    } else if (open === 5) {
      out.invalidation = { price: P[4], reason: '4파 끝 이탈 시 이 카운트 폐기' };
      t(ext(P[4], w1, 0.618), '5파 = 1파×0.618'); t(ext(P[4], w1, 1.0), '5파 = 1파');
      t(ext(P[4], Math.abs(P[3] - P[0]), 0.618), '5파 = (0→3)×0.618');
      if (w3 < w1) t(ext(P[4], w3, 1.0), '5파 최대 (3파가 최단이 되면 안 됨)');
    } else if (open >= 6) {
      const imp = Math.abs(P[5] - P[0]);
      if (open === 6) { t(ext(P[5], imp, -0.382), '조정 0.382'); t(ext(P[5], imp, -0.5), '조정 0.5'); t(ext(P[5], imp, -0.618), '조정 0.618'); }
      if (open === 7) { out.invalidation = { price: P[5], reason: 'B파가 5파 끝을 넘으면 지그재그 아님' }; t(ext(P[6], Math.abs(P[6] - P[5]), 0.5), 'B파 0.5'); t(ext(P[6], Math.abs(P[6] - P[5]), 0.618), 'B파 0.618'); }
      if (open === 8) { out.invalidation = { price: P[7], reason: 'B파 끝 이탈 시 이 카운트 폐기' }; const a = Math.abs(P[6] - P[5]); t(ext(P[7], a, -1.0), 'C파 = A파'); t(ext(P[7], a, -1.618), 'C파 = A파×1.618'); }
    }
    return out;
  }

  // 현재 시점까지 이어지는, 규칙 위반 없는 가장 긴 카운트를 찾는다.
  function auto(c, A, opts) {
    opts = opts || {};
    const mults = opts.mult ? [opts.mult] : [9, 6, 4, 3, 2];
    let best = null;
    for (const mult of mults) {
      const piv = zigzag(c, A, mult);
      const last = piv.length - 1;
      for (let a = Math.max(0, last - 8); a <= last - 2; a++) {
        const seq = piv.slice(a), dir = seq[0].type === 'L' ? 1 : -1;
        const prices = seq.map((p) => p.price);
        if (validate(prices, dir, true).length) continue;
        const k = seq.length - 1;
        if (!best || k > best.k) best = { k, dir, mult, pivots: seq, prices };
        break; // 이 스케일에서는 가장 이른(가장 긴) 유효 시작점만
      }
    }
    if (!best) return null;
    return Object.assign(
      { dir: best.dir, mult: best.mult, labels: best.pivots.map((p, i) => ({ idx: p.idx, price: p.price, text: NAMES[i], provisional: !!p.provisional })) },
      project(best.prices, best.dir, true)
    );
  }

  // 수동 카운트: points=[{price}] (0부터 순서대로). 방향은 첫 두 점으로 결정.
  function manual(points) {
    if (points.length < 2) return { dir: 0, violations: [], invalidation: null, targets: [], stage: points.length ? '1파 끝을 찍으세요' : '0(시작점)을 찍으세요' };
    const prices = points.map((p) => p.price), dir = prices[1] > prices[0] ? 1 : -1;
    return Object.assign({ dir, violations: validate(prices, dir, false) }, project(prices, dir, false));
  }

  ET.elliott = { zigzag, validate, project, auto, manual, NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
