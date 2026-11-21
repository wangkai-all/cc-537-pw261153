/*
 * run-tests.js — 核心算法自动化测试（Node 直接运行，无依赖）。
 * 用法: node test/run-tests.js
 */
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'core.js'));
const SAMPLES = require(path.join(__dirname, '..', 'samples.js'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function approx(a, b, tol, name) { ok(Math.abs(a - b) <= (tol || 1e-9), name, `got ${a}, want ${b}`); }
function section(t) { console.log('\n[' + t + ']'); }

const S = (t, v) => ({ tMs: Math.round(t * 1000), t, v });
const segPairs = (segs) => segs.map(s => [s.i0, s.i1]);

/* 压缩 → 导出 → 序列化 → 独立解码 → 逐点核对 的完整回路 */
function roundTrip(samples, speedEps, distEps) {
  const runs = [{ samples, breakBefore: null }];
  const compressed = Core.compressRuns(runs, speedEps, distEps);
  const fileText = JSON.stringify(Core.exportFile(compressed, { speedEps, distEps, gapThreshold: 60 }));
  const decoded = Core.decodeFile(fileText); // 解码器只读文件文本
  const verification = Core.verify(decoded, runs, speedEps, distEps);
  return { compressed, fileText, decoded, verification };
}

/* ---------- 1. 单位换算 ---------- */
section('单位换算');
approx(Core.unitToMps('km/h') * 3.6, 1, 1e-12, 'km/h → m/s');
approx(Core.unitToMps('mph'), 0.44704, 1e-12, 'mph → m/s');
approx(Core.unitToMps('m/s'), 1, 1e-12, 'm/s 恒等');
ok(Core.unitToMps('lightyear') === null, '未知单位返回 null');

/* ---------- 2. 时间解析 ---------- */
section('时间解析');
ok(Core.parseTimeToMs('12.5') === 12500, '相对秒 → 毫秒');
ok(Core.parseTimeToMs(1700000000) === 1700000000000, 'epoch 秒 → 毫秒');
ok(Core.parseTimeToMs(1700000000123) === 1700000000123, 'epoch 毫秒保持不变');
ok(Core.parseTimeToMs('2026-11-22T01:00:00Z') === Date.parse('2026-11-22T01:00:00Z'), 'ISO 字符串');
ok(Core.parseTimeToMs('不是时间') === null, '非法时间 → null');

/* ---------- 3. CSV 解析（含停机标记、单位列） ---------- */
section('CSV 解析');
{
  const { records, errors } = Core.parseCSV('time,speed,unit,flag\n0,60,km/h,\n10,16.6667,m/s,\n20,,,stop\n30,10,mph,', 'm/s');
  ok(errors.length === 0, '无解析错误', JSON.stringify(errors));
  ok(records.length === 4, '4 条记录');
  approx(records[0].v, 60 / 3.6, 1e-9, '行内单位 km/h 生效');
  approx(records[1].v, 16.6667, 1e-9, '行内单位 m/s 生效');
  ok(records[2].stop === true && records[2].tMs === 20000, '停机标记识别');
  approx(records[3].v, 10 * 0.44704, 1e-9, '行内单位 mph 生效');
}
{
  const { records, errors } = Core.parseCSV('0,10\n5,12', 'km/h'); // 无表头
  ok(errors.length === 0 && records.length === 2, '无表头两列可解析');
  approx(records[0].v, 10 / 3.6, 1e-9, '默认单位作用于无表头数据');
}

/* ---------- 4. 匀速：极限压缩为 2 个断点 ---------- */
section('匀速巡航');
{
  const samples = [];
  for (let t = 0; t <= 600; t += 10) samples.push(S(t, 60 / 3.6));
  const { compressed, verification } = roundTrip(samples, 0.5, 20);
  ok(compressed[0].points.length === 2, '61 个采样 → 2 个断点', '实际 ' + compressed[0].points.length);
  ok(verification.ok && verification.maxSpeedErr === 0 && verification.maxAbsCumDev === 0, '误差为 0，核对通过');
}

/* ---------- 5. 可行性不随终点单调：必须检查全部候选 ---------- */
section('候选终点全检查（速度约束非单调）');
{
  // j=2 的弦在中点超速度预算，j=3 的弦反而合规；提前退出会错选 j=1
  const samples = [S(0, 0), S(1, 10), S(2, 12), S(3, 21)];
  const c = Core.compressRun(samples, 3, 1e9);
  ok(JSON.stringify(segPairs(c.segments)) === JSON.stringify([[0, 3]]),
    'j=2 失败、j=3 可行 → 首段直达终点', JSON.stringify(segPairs(c.segments)));
}

/* ---------- 6. 里程偏差逐时刻检查 + 距离约束非单调 ---------- */
section('累计里程偏差逐时刻检查');
{
  // 拱形 [10,12,10,8,10]：整段弦末端累计偏差=0，但中点 |偏差|=2
  const mk = () => [S(0, 10), S(1, 12), S(2, 10), S(3, 8), S(4, 10)];
  {
    const c = Core.compressRun(mk(), 5, 1.5);
    // 只看末端（偏差0）会误判整段通过；逐时刻检查必须在 t=2 处拒绝 0→4
    ok(c.segments[0].i1 === 1, '预算1.5m：中点偏差2m超限，首段只能到 t=1', JSON.stringify(segPairs(c.segments)));
    ok(JSON.stringify(segPairs(c.segments)) === JSON.stringify([[0, 1], [1, 3], [3, 4]]),
      '分段结果符合预期', JSON.stringify(segPairs(c.segments)));
  }
  {
    const c = Core.compressRun(mk(), 5, 2);
    // j=3 失败（中点偏差3.33m），j=4 反而可行（逐点最大2m）→ 距离约束同样非单调
    ok(JSON.stringify(segPairs(c.segments)) === JSON.stringify([[0, 4]]),
      '预算2m：j=3 失败、j=4 可行 → 一段到底', JSON.stringify(segPairs(c.segments)));
  }
  {
    const { verification } = roundTrip(mk(), 5, 1.5);
    ok(verification.ok, '回读文件逐点核对通过');
    ok(verification.maxAbsCumDev <= 1.5 + 1e-9, '最大累计里程偏差 ≤ 预算', verification.maxAbsCumDev);
  }
}

/* ---------- 7. 累计偏差跨段结转（不能只按段内局部值判断） ---------- */
section('累计里程偏差跨段结转');
{
  // 首段结束已结转 +0.4m；后续段局部偏差 0.2/0.4 各自不超限，
  // 但结转后 0.4+0.4=0.8 超预算 0.6 → 必须提前切断
  const samples = [S(0, 10), S(1, 9.6), S(2, 10), S(3, 20), S(4, 19.6), S(5, 20), S(6, 20)];
  const c = Core.compressRun(samples, 0.5, 0.6);
  ok(JSON.stringify(segPairs(c.segments)) === JSON.stringify([[0, 2], [2, 3], [3, 4], [4, 6]]),
    '按运行级累计值切断', JSON.stringify(segPairs(c.segments)));
  const { verification } = roundTrip(samples, 0.5, 0.6);
  ok(verification.ok && verification.maxAbsCumDev <= 0.6 + 1e-9, '核对通过且累计偏差 ≤ 0.6m');
}

/* ---------- 8. 缺口与停机切断连续区间 ---------- */
section('缺口 / 停机切断');
{
  const rec = (t, v, flag) => ({ line: 0, tMs: t * 1000, stop: !!flag, v, rawV: v, unit: 'm/s', rawTime: String(t) });
  const records = [
    rec(0, 10), rec(10, 10), rec(20, 10),          // 区间1
    rec(200, 12), rec(210, 12),                     // 区间2（180s 缺口）
    { line: 0, tMs: 215000, stop: true, v: null, rawV: null, unit: null, rawTime: '215' }, // 停机
    rec(220, 14), rec(230, 14),                     // 区间3（仅10s间隔，靠停机切断）
  ];
  const ds = Core.buildDataset(records, 60);
  ok(ds.runs.length === 3, '切为 3 个连续区间', String(ds.runs.length));
  ok(ds.runs[1].breakBefore.reason === 'gap' && ds.runs[1].breakBefore.gapSeconds === 180, '第二段起因：缺口 180s');
  ok(ds.runs[2].breakBefore.reason === 'stop' && ds.runs[2].breakBefore.at === 215, '第三段起因：停机标记 @215s');
  const compressed = Core.compressRuns(ds.runs, 0.5, 20);
  const decoded = Core.decodeFile(JSON.stringify(Core.exportFile(compressed, { speedEps: 0.5, distEps: 20, gapThreshold: 60 })));
  ok(decoded.runs.length === 3, '导出文件保留 3 个区间与断开口信息');
  ok(decoded.runs[1].breakBefore.reason === 'gap' && decoded.runs[2].breakBefore.reason === 'stop', '断开口原因随文件导出');
  ok(Core.interpPoints(decoded.runs[0].points, 100) === null, '缺口内不插值（返回 null）');
  const v = Core.verify(decoded, ds.runs, 0.5, 20);
  ok(v.ok, '逐点核对通过');
  // 里程只覆盖连续区间：缺口 180s 不产生任何里程
  approx(v.totals.origDist, 10 * 20 + 12 * 10 + 14 * 10, 1e-9, '缺口里程不凭空补算');
  approx(v.totals.decDist, v.totals.origDist, 1e-9, '解码里程与原始一致');
}

/* ---------- 9. 同刻冲突隔离与修正 ---------- */
section('同刻冲突隔离 / 修正');
{
  const rec = (line, t, v) => ({ line, tMs: t * 1000, stop: false, v, rawV: v, unit: 'm/s', rawTime: String(t) });
  const records = [rec(1, 0, 10), rec(2, 10, 11), rec(3, 10, 13), rec(4, 20, 12), rec(5, 20, 12), rec(6, 30, 12)];
  const ds = Core.buildDataset(records, 60);
  ok(ds.conflicts.length === 1 && ds.conflicts[0].tMs === 10000, 't=10 冲突组被隔离');
  ok(ds.conflicts[0].records.length === 2, '冲突组原值保留 2 条');
  ok(ds.deduped === 1, 't=20 完全重复 → 去重 1 条');
  ok(ds.samples.every(s => s.tMs !== 10000), '冲突时刻不进样本');
  ok(ds.samples.length === 3, '样本数 = 3（6 条 - 2 冲突 - 1 重复）', String(ds.samples.length));

  const fixes = new Map([[10000, { line: 3, value: 13 }]]);
  const ds2 = Core.buildDataset(records, 60, fixes);
  ok(ds2.conflicts[0].fixed === true && ds2.conflicts[0].fixValue === 13, '修正后标记已修正');
  ok(ds2.conflicts[0].records.length === 2, '修正后原值仍保留');
  ok(ds2.samples.some(s => s.tMs === 10000 && s.v === 13), '修正值进入样本');
}

/* ---------- 10. 短尖峰保留 ---------- */
section('短尖峰');
{
  const pts = [[0, 50], [100, 50], [110, 50], [111, 85], [112, 88], [113, 50], [120, 50], [200, 50]]
    .map(p => S(p[0], p[1] / 3.6));
  const { compressed, verification } = roundTrip(pts, 0.5, 20);
  ok(compressed[0].points.length > 2, '尖峰迫使保留中间断点', String(compressed[0].points.length));
  ok(verification.ok, '核对通过');
  ok(verification.maxSpeedErr <= 0.5 + 1e-9, '速度误差 ≤ 预算');
}

/* ---------- 11. 内置示例数据全部通过完整回路 ---------- */
section('内置示例数据（解析→压缩→导出→解码→核对）');
for (const key of Object.keys(SAMPLES)) {
  const sample = SAMPLES[key];
  const { records, errors } = Core.parseCSV(sample.csv, 'km/h');
  ok(errors.length === 0, sample.name + '：解析无错误', JSON.stringify(errors.slice(0, 2)));
  const ds = Core.buildDataset(records, 60);
  const params = { speedEps: 0.5, distEps: 20, gapThreshold: 60 };
  const compressed = Core.compressRuns(ds.runs, params.speedEps, params.distEps);
  const fileText = JSON.stringify(Core.exportFile(compressed, params));
  const decoded = Core.decodeFile(fileText);
  const v = Core.verify(decoded, ds.runs, params.speedEps, params.distEps);
  ok(v.ok, sample.name + '：逐点核对通过', v.problems.slice(0, 2).join('；'));
  ok(v.maxSpeedErr <= params.speedEps + 1e-9 && v.maxAbsCumDev <= params.distEps + 1e-9,
    sample.name + '：两类误差均在预算内',
    `速度 ${v.maxSpeedErr.toFixed(4)}/±${params.speedEps}，里程 ${v.maxAbsCumDev.toFixed(3)}/±${params.distEps}`);
  const nPts = compressed.reduce((a, r) => a + r.points.length, 0);
  console.log('    → ' + sample.name + '：采样 ' + ds.samples.length + ' → 断点 ' + nPts +
    '，区间 ' + ds.runs.length + '，文件 ' + fileText.length + ' B' +
    '，最大速度误差 ' + v.maxSpeedErr.toFixed(4) + ' m/s，最大累计里程偏差 ' + v.maxAbsCumDev.toFixed(3) + ' m');
}
{
  // 专项断言：示例数据的结构特征
  const dsConst = Core.buildDataset(Core.parseCSV(SAMPLES.constant.csv, 'km/h').records, 60);
  ok(Core.compressRuns(dsConst.runs, 0.5, 20)[0].points.length === 2, '匀速示例压缩为 2 个断点');
  const dsGap = Core.buildDataset(Core.parseCSV(SAMPLES.gapStop.csv, 'km/h').records, 60);
  ok(dsGap.runs.length === 3, '长缺口+停机示例切为 3 个区间', String(dsGap.runs.length));
  ok(dsGap.runs[1].breakBefore.reason === 'gap' && dsGap.runs[2].breakBefore.reason === 'stop', '断开口原因正确');
  const dsArch = Core.buildDataset(Core.parseCSV(SAMPLES.arch.csv, 'm/s').records, 60);
  const cArch = Core.compressRuns(dsArch.runs, 0.5, 20);
  ok(cArch[0].points.length > 2, '先增后减示例必须分段（不能一弦到底）', String(cArch[0].points.length));
  const dsConf = Core.buildDataset(Core.parseCSV(SAMPLES.conflict.csv, 'km/h').records, 60);
  ok(dsConf.conflicts.length === 1 && !dsConf.conflicts[0].fixed, '冲突示例隔离 1 组');
  ok(dsConf.deduped === 1, '冲突示例去重 1 条');
  ok(dsConf.runs.length === 2, '冲突示例被停机标记切为 2 个区间');
}

/* ---------- 12. 独立解码器的文件校验 ---------- */
section('独立解码器');
{
  let threw = 0;
  try { Core.decodeFile('{"format":"别的"}'); } catch (e) { threw++; }
  try { Core.decodeFile('{"format":"veh-speed-plc","version":99}'); } catch (e) { threw++; }
  try { Core.decodeFile('{"format":"veh-speed-plc","version":1,"units":{"time":"s","speed":"km/h"},"runs":[]}'); } catch (e) { threw++; }
  ok(threw === 3, '非本格式 / 版本不符 / 单位不符 均被拒绝');
  const good = JSON.stringify(Core.exportFile(Core.compressRuns(
    [[S(0, 10), S(1, 11), S(2, 10)].map(s => ({ tMs: s.tMs, t: s.t, v: s.v }))].map(ss => ({ samples: ss, breakBefore: null })),
    0.5, 20), { speedEps: 0.5, distEps: 20, gapThreshold: 60 }));
  const d = Core.decodeFile(good);
  ok(d.meta.units.speed === 'm/s' && d.meta.params.speedEps === 0.5, '文件携带单位与压缩参数');
}

/* ---------- 13. 上传文件与原始数据不匹配时如实报错 ---------- */
section('文件与原始数据不匹配');
{
  const samples = [S(0, 10), S(1, 11), S(2, 10)];
  const { decoded } = roundTrip(samples, 0.5, 20);
  const otherRuns = [{ samples: [S(0, 10), S(1, 11), S(2, 10), S(3, 9)], breakBefore: null }];
  const v = Core.verify(decoded, otherRuns, 0.5, 20);
  ok(!v.ok && v.problems.length > 0, '端点时刻不一致被检出');
}

console.log('\n========================================');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
