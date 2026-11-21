/*
 * samples.js — 内置示例数据（CSV 文本，列：time,speed,unit,flag）。
 * 覆盖压缩边界：匀速、短尖峰（采样间隔不固定）、长缺口+停机标记、
 * 累计里程偏差先增后减、同刻冲突记录。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAMPLES = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function csv(rows) { return 'time,speed,unit,flag\n' + rows.join('\n') + '\n'; }
  function round(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }

  /* 1. 匀速巡航：应压缩为每段区间 2 个断点、误差为 0 */
  const constant = (() => {
    const rows = [];
    for (let t = 0; t <= 600; t += 10) rows.push(t + ',60,km/h,');
    return csv(rows);
  })();

  /* 2. 短尖峰：10s 常规采样中插入 1s 密集采样的短时加速（采样间隔不固定） */
  const spike = (() => {
    const pts = [];
    for (let t = 0; t <= 300; t += 10) {
      if (t >= 120 && t <= 130) continue;
      pts.push([t, 50]);
    }
    const peak = { 121: 63, 122: 85, 123: 88, 124: 71, 125: 54 };
    Object.keys(peak).forEach(k => pts.push([Number(k), peak[k]]));
    pts.sort((a, b) => a[0] - b[0]);
    return csv(pts.map(p => p[0] + ',' + p[1] + ',km/h,'));
  })();

  /* 3. 长缺口 + 停机标记：三段连续区间，缺口与停机都必须切断、两侧不插值 */
  const gapStop = (() => {
    const rows = [];
    for (let t = 0; t <= 240; t += 12) rows.push(t + ',' + round(40 + 6 * Math.sin(t / 40), 2) + ',km/h,');
    for (let t = 900; t <= 1200; t += 15) rows.push(t + ',' + round(55 + 4 * Math.sin(t / 50), 2) + ',km/h,');
    rows.push('1210,,,stop'); // 停机标记：1200→1220 仅隔 20s（小于缺口阈值），靠标记切断
    for (let t = 1220; t <= 1500; t += 14) rows.push(t + ',' + round(45 + 5 * Math.sin(t / 45), 2) + ',km/h,');
    return csv(rows);
  })();

  /* 4. 累计里程偏差先增后减：速度拱形对称，首尾同为 10 m/s，
        整条弦的末端里程偏差≈0，但中点偏差最大 —— 只看末端会误判通过 */
  const arch = (() => {
    const rows = [];
    for (let t = 0; t <= 200; t += 4) rows.push(t + ',' + round(10 + 3 * Math.sin(Math.PI * t / 200), 4) + ',m/s,');
    return csv(rows);
  })();

  /* 5. 同刻冲突 + 完全重复 + 停机标记：冲突组被隔离（原值保留），重复行去重 */
  const conflict = (() => {
    const rows = [];
    for (let t = 0; t <= 120; t += 6) rows.push(t + ',30,km/h,');
    rows.push('60,34,km/h,'); // 与 "60,30" 同刻冲突 → 整组隔离
    rows.push('66,30,km/h,'); // 与 "66,30" 完全重复 → 去重
    rows.push('130,,,stop');
    for (let t = 140; t <= 260; t += 10) rows.push(t + ',32,km/h,');
    return csv(rows);
  })();

  return {
    constant: { name: '匀速巡航', csv: constant, desc: '60 km/h 匀速 10 分钟，验证极限压缩（每区间 2 个断点）' },
    spike: { name: '短尖峰', csv: spike, desc: '50 km/h 巡航中一次 5 秒急加速，采样间隔 10s/1s 混合' },
    gapStop: { name: '长缺口+停机', csv: gapStop, desc: '660s 采样缺口与停机标记各切断一次，共 3 个连续区间' },
    arch: { name: '累计偏差先增后减', csv: arch, desc: '速度拱形：末端里程偏差≈0、中点最大，专查"只看末端"的误判' },
    conflict: { name: '同刻冲突+停机', csv: conflict, desc: 't=60 两条速度冲突（隔离待修正）、t=66 完全重复（去重）' },
  };
});
