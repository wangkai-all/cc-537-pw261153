/*
 * core.js — 车载速度记录：采样接入、分段线性压缩、独立解码、逐点核对。
 * 浏览器（window.SpeedCore）与 Node（module.exports）通用，无外部依赖。
 *
 * 约定：
 *  - 内部时间统一为毫秒整数（tMs），导出文件统一为秒（number）。
 *  - 速度统一为米每秒（m/s），里程为米（m）。
 *  - 连续区间（run）：被停机标记或超过阈值的采样缺口切分出的样本序列；
 *    区间之间不插值、不凭空补算里程。
 *  - 里程基准：原始相邻点的梯形积分。约束为"连续区间内累计有符号里程偏差"
 *    在每个原采样时刻的绝对值都不超限（不是只看末端，正负抵消不算数）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeedCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FORMAT = 'veh-speed-plc';
  const VERSION = 1;

  const UNIT_TO_MPS = {
    'm/s': 1, 'mps': 1, 'ms': 1, '米/秒': 1, '米每秒': 1,
    'km/h': 1 / 3.6, 'kmh': 1 / 3.6, 'kph': 1 / 3.6, '公里/小时': 1 / 3.6, '千米/小时': 1 / 3.6,
    'mph': 0.44704,
  };

  function unitToMps(unit) {
    if (unit == null) return null;
    const k = String(unit).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(UNIT_TO_MPS, k) ? UNIT_TO_MPS[k] : null;
  }

  /* 时间解析：相对秒 / epoch 秒 / epoch 毫秒 / ISO 字符串 → 毫秒整数 */
  function parseTimeToMs(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number' && isFinite(raw)) return numberToMs(raw);
    const s = String(raw).trim();
    if (!s) return null;
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return numberToMs(Number(s));
    const iso = Date.parse(s.replace(' ', 'T'));
    if (!isNaN(iso)) return Math.round(iso);
    return null;
  }

  function numberToMs(x) {
    const a = Math.abs(x);
    if (a >= 1e14) return null;          // 微秒级及以上不支持
    if (a >= 1e11) return Math.round(x); // epoch 毫秒
    if (a >= 1e8) return Math.round(x * 1000); // epoch 秒（1973 年之后）
    return Math.round(x * 1000);         // 相对秒
  }

  const HEADER_MAP = {
    time: ['time', 'timestamp', 't', 'ts', '时间', '时间戳', '时刻'],
    speed: ['speed', 'v', 'velocity', '速度'],
    unit: ['unit', 'units', '单位'],
    flag: ['flag', 'mark', 'marker', 'type', '标记', '类型', '标志'],
  };

  function detectDelim(line) {
    let best = ',', bestN = 0;
    for (const c of [',', '\t', ';']) {
      const n = line.split(c).length - 1;
      if (n > bestN) { bestN = n; best = c; }
    }
    return best;
  }

  /*
   * 解析 CSV 文本 → { records, errors }
   * record: { line, tMs, stop, v(m/s)|null, rawV, unit, rawTime }
   * 停机标记行（flag 列匹配 stop/停机/熄火/off）只作为切分标记，不作为速度样本。
   */
  function parseCSV(text, defaultUnit) {
    const records = [];
    const errors = [];
    let delim = null, cols = null;
    linesOf(text).forEach((rawLine, idx) => {
      const lineNo = idx + 1;
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      if (delim === null) delim = detectDelim(line);
      const cells = line.split(delim).map(s => s.trim());
      if (cols === null) {
        const lower = cells.map(c => c.toLowerCase());
        const find = (names) => lower.findIndex(c => names.indexOf(c) >= 0);
        const ti = find(HEADER_MAP.time), si = find(HEADER_MAP.speed);
        if (ti >= 0 && si >= 0) { // 表头行
          cols = { time: ti, speed: si, unit: find(HEADER_MAP.unit), flag: find(HEADER_MAP.flag) };
          return;
        }
        cols = { time: 0, speed: 1, unit: -1, flag: -1 }; // 无表头：前两列
      }
      const rawTime = cells[cols.time];
      const tMs = parseTimeToMs(rawTime);
      const flagRaw = cols.flag >= 0 ? (cells[cols.flag] || '') : '';
      if (/stop|停机|熄火|off/i.test(flagRaw)) {
        if (tMs === null) { errors.push({ line: lineNo, msg: '停机标记时间无法解析', raw: line }); return; }
        records.push({ line: lineNo, tMs, stop: true, v: null, rawV: null, unit: null, rawTime });
        return;
      }
      const vRaw = Number(cells[cols.speed]);
      const unit = (cols.unit >= 0 && cells[cols.unit]) ? cells[cols.unit] : (defaultUnit || 'm/s');
      const factor = unitToMps(unit);
      if (tMs === null) { errors.push({ line: lineNo, msg: '时间无法解析', raw: line }); return; }
      if (!isFinite(vRaw)) { errors.push({ line: lineNo, msg: '速度不是数字', raw: line }); return; }
      if (factor === null) { errors.push({ line: lineNo, msg: '未知速度单位: ' + unit, raw: line }); return; }
      records.push({ line: lineNo, tMs, stop: false, v: vRaw * factor, rawV: vRaw, unit, rawTime });
    });
    return { records, errors };
  }

  function linesOf(text) { return String(text == null ? '' : text).split(/\r\n|\r|\n/); }

  /*
   * 构建数据集：去重、隔离同刻冲突、按停机标记与采样缺口切分连续区间。
   * fixes: Map(tMs → { line, value }) — 对冲突组的人工修正（保留原值，另存修正值）。
   * 返回 { samples, conflicts, stops, runs, deduped }
   *   samples/runs 中样本: { tMs, t(秒), v(m/s) }
   *   runs[i].breakBefore: null | { reason:'gap'|'stop', at?, gapSeconds }
   */
  function buildDataset(records, gapThresholdS, fixes) {
    let gapMs = Number(gapThresholdS) * 1000;
    if (!(gapMs > 0)) gapMs = Infinity; // 阈值 <= 0 表示不按缺口切分
    const fixMap = fixes || new Map();
    const stops = records.filter(r => r.stop).map(r => r.tMs).sort((a, b) => a - b);

    const groups = new Map();
    for (const r of records) {
      if (r.stop) continue;
      if (!groups.has(r.tMs)) groups.set(r.tMs, []);
      groups.get(r.tMs).push(r);
    }

    const conflicts = [];
    const samples = [];
    let deduped = 0;
    for (const [tMs, recs] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
      const distinct = [];
      for (const r of recs) if (!distinct.some(d => Math.abs(d - r.v) <= 1e-9)) distinct.push(r.v);
      const isConflict = distinct.length > 1;
      const fix = fixMap.get(tMs);
      if (isConflict && !fix) {
        conflicts.push({ tMs, records: recs, fixed: false }); // 隔离：原值保留，不进样本
        continue;
      }
      let v;
      if (isConflict && fix) {
        v = fix.value;
        conflicts.push({ tMs, records: recs, fixed: true, fixValue: fix.value, fixLine: fix.line });
      } else {
        v = distinct[0];
        deduped += recs.length - 1;
      }
      samples.push({ tMs, t: tMs / 1000, v });
    }

    // 切分连续区间：缺口超阈值或中间有停机标记 → 断开
    const rawRuns = [];
    let cur = [];
    let curStop = null;
    for (const s of samples) {
      if (cur.length === 0) { cur = [s]; continue; }
      const prev = cur[cur.length - 1];
      const dtMs = s.tMs - prev.tMs;
      let stopBetween;
      for (const st of stops) { if (st > prev.tMs && st <= s.tMs) { stopBetween = st; break; } }
      if (stopBetween !== undefined || dtMs > gapMs) {
        rawRuns.push({ samples: cur });
        cur = [s];
        curStop = stopBetween !== undefined ? stopBetween : null;
        cur._breakStop = curStop;
      } else {
        cur.push(s);
      }
    }
    if (cur.length) rawRuns.push({ samples: cur, _breakStop: curStop });

    const runs = rawRuns.map((r, i) => {
      let breakBefore = null;
      if (i > 0) {
        const prevLast = rawRuns[i - 1].samples[rawRuns[i - 1].samples.length - 1];
        const first = r.samples[0];
        const gapSeconds = (first.tMs - prevLast.tMs) / 1000;
        breakBefore = (r._breakStop !== undefined && r._breakStop !== null)
          ? { reason: 'stop', at: r._breakStop / 1000, gapSeconds }
          : { reason: 'gap', gapSeconds };
      }
      return { samples: r.samples, breakBefore };
    });

    return { samples, conflicts, stops, runs, deduped };
  }

  /*
   * 分段线性压缩（贪心取最远可行终点）。
   * 每段用首尾采样点连线；两类限制都满足才可取：
   *  1) 段内每个原采样时刻 |连线速度 - 原始速度| <= speedEps；
   *  2) 连续区间内累计有符号里程偏差（含前面各段结转的 cumBase）在段内
   *     每个原采样时刻的绝对值都 <= distEps。
   * 注意：可行性不随终点单调（近端失败不代表更远也失败），
   *       因此必须检查全部候选终点，不能提前退出。
   */
  function compressRun(samples, speedEps, distEps) {
    const n = samples.length;
    if (n === 0) return { points: [], segments: [] };
    if (n === 1) return { points: [[samples[0].t, samples[0].v]], segments: [] };
    const t = samples.map(s => s.t), v = samples.map(s => s.v);
    const pref = new Float64Array(n); // pref[k] = 原始梯形积分（样本0 → 样本k）
    for (let k = 1; k < n; k++) pref[k] = pref[k - 1] + (v[k - 1] + v[k]) / 2 * (t[k] - t[k - 1]);

    function feasible(i, j, cumBase) {
      const t0 = t[i], v0 = v[i], dt = t[j] - t0;
      if (dt <= 0) return false;
      const slope = (v[j] - v0) / dt;
      for (let k = i + 1; k < j; k++) { // 速度误差：每个原采样时刻
        const vhat = v0 + slope * (t[k] - t0);
        if (Math.abs(vhat - v[k]) > speedEps) return false;
      }
      for (let m = i + 1; m <= j; m++) { // 累计里程偏差：每个原采样时刻（含终点）
        const vhatM = v0 + slope * (t[m] - t0);
        const dev = cumBase + (v0 + vhatM) / 2 * (t[m] - t0) - (pref[m] - pref[i]);
        if (Math.abs(dev) > distEps) return false;
      }
      return true;
    }

    const segments = [];
    const pointIdx = [0];
    let i = 0, cumBase = 0;
    while (i < n - 1) {
      let best = i + 1; // 相邻两点必然可行（弦过两端点、区间梯形一致、|cumBase| 已被上一步保证）
      for (let j = i + 1; j < n; j++) { // 检查全部候选，不提前退出
        if (feasible(i, j, cumBase)) best = j;
      }
      cumBase += (v[i] + v[best]) / 2 * (t[best] - t[i]) - (pref[best] - pref[i]);
      segments.push({ i0: i, i1: best });
      pointIdx.push(best);
      i = best;
    }
    return { points: pointIdx.map(k => [t[k], v[k]]), segments };
  }

  function compressRuns(runs, speedEps, distEps) {
    return runs.map(r => {
      const c = compressRun(r.samples, speedEps, distEps);
      return {
        points: c.points,
        segments: c.segments,
        breakBefore: r.breakBefore || null,
        sourceCount: r.samples.length,
      };
    });
  }

  /* 导出文件：单位、断点（分段端点 + 断开口信息）、压缩参数 */
  function exportFile(compressedRuns, params) {
    return {
      format: FORMAT,
      version: VERSION,
      units: { time: 's', speed: 'm/s', distance: 'm' },
      params: {
        speedEps: params.speedEps,
        distEps: params.distEps,
        gapThreshold: params.gapThreshold,
      },
      generatedAt: new Date().toISOString(),
      runs: compressedRuns.map(r => ({
        breakBefore: r.breakBefore ? Object.assign({}, r.breakBefore) : null,
        points: r.points.map(p => [p[0], p[1]]),
      })),
    };
  }

  /* 独立解码器：只读文件文本，不接触原始输入 */
  function decodeFile(text) {
    const obj = typeof text === 'string' ? JSON.parse(text) : text;
    if (!obj || obj.format !== FORMAT) throw new Error('不是本工具导出的压缩文件（format 不匹配）');
    if (obj.version !== VERSION) throw new Error('不支持的文件版本: ' + obj.version);
    const units = obj.units || {};
    if (units.time !== 's' || units.speed !== 'm/s') {
      throw new Error('文件单位不是 秒 / 米每秒，独立解码器拒绝解码');
    }
    const runs = (obj.runs || []).map(r => ({
      breakBefore: r.breakBefore || null,
      points: (r.points || []).map(p => ({ t: Number(p[0]), v: Number(p[1]) })),
    }));
    runs.forEach((r, i) => {
      for (let k = 1; k < r.points.length; k++) {
        if (!(r.points[k].t > r.points[k - 1].t)) throw new Error('区间 ' + (i + 1) + ' 断点时间未严格递增');
      }
    });
    return { meta: { units, params: obj.params || {}, generatedAt: obj.generatedAt || null }, runs };
  }

  /* 在断点折线上取值；超出覆盖范围返回 null（不外推、不跨区间插值） */
  function interpPoints(points, t) {
    const n = points.length;
    if (n === 0) return null;
    if (t < points[0].t - 1e-9 || t > points[n - 1].t + 1e-9) return null;
    if (n === 1) return points[0].v;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    if (b.t === a.t) return a.v;
    return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  }

  function utilOf(x, eps) { return eps > 0 ? x / eps : (x > 1e-12 ? Infinity : 0); }

  /*
   * 逐点核对：解码结果（仅来自文件） vs 原始输入。
   *  - 每个原采样时刻的速度误差 |v解码 - v原始| <= speedEps
   *  - 每个连续区间内，累计有符号里程偏差在每个原采样时刻 |cum| <= distEps
   * 返回每个样本的明细、每个分段的统计、最接近预算上限的分段（worst）。
   */
  function verify(decoded, origRuns, speedEps, distEps) {
    const SLACK = 1e-9;
    const res = {
      ok: true, problems: [], runs: [],
      maxSpeedErr: 0, maxAbsCumDev: 0, worst: null,
      totals: { origDist: 0, decDist: 0 },
    };
    const fail = (msg) => { res.ok = false; if (res.problems.length < 20) res.problems.push(msg); };
    if (!decoded || !Array.isArray(decoded.runs)) { fail('文件中没有 runs 数组'); return res; }
    if (decoded.runs.length !== origRuns.length) {
      fail('连续区间数量不一致：文件 ' + decoded.runs.length + ' 个，原始数据 ' + origRuns.length + ' 个');
      return res;
    }
    decoded.runs.forEach((dr, ri) => {
      const orig = origRuns[ri].samples;
      const pts = dr.points;
      const runRes = { maxSpeedErr: 0, maxAbsCumDev: 0, segments: [], samples: [], origDist: 0, decDist: 0 };
      res.runs.push(runRes);
      for (let k = 0; k + 1 < pts.length; k++) {
        runRes.segments.push({ t0: pts[k].t, t1: pts[k + 1].t, maxSpeedErr: 0, maxAbsCumDev: 0, util: 0 });
      }
      if (!pts.length) {
        if (orig.length) fail('区间 ' + (ri + 1) + '：文件中没有断点，原始数据有 ' + orig.length + ' 个采样');
        return;
      }
      if (orig.length) {
        const dT0 = Math.abs(orig[0].t - pts[0].t);
        const dT1 = Math.abs(orig[orig.length - 1].t - pts[pts.length - 1].t);
        if (dT0 > 1e-6 || dT1 > 1e-6) fail('区间 ' + (ri + 1) + '：文件起止时刻与原始数据不一致');
      }
      let cum = 0, segIdx = 0;
      orig.forEach((s, k) => {
        const vDec = interpPoints(pts, s.t);
        if (vDec === null) { fail('区间 ' + (ri + 1) + '：时刻 ' + s.t + 's 超出文件覆盖范围，无法解码'); return; }
        const err = Math.abs(vDec - s.v);
        if (k > 0) {
          const p = orig[k - 1];
          const vDecP = interpPoints(pts, p.t);
          const dt = s.t - p.t;
          const dOrig = (p.v + s.v) / 2 * dt;
          const dDec = (vDecP + vDec) / 2 * dt;
          cum += dDec - dOrig;
          runRes.origDist += dOrig;
          runRes.decDist += dDec;
        }
        if (err > speedEps + SLACK) {
          fail('区间 ' + (ri + 1) + ' 时刻 ' + s.t + 's：速度误差 ' + err.toFixed(4) + ' m/s 超预算 ±' + speedEps);
        }
        if (Math.abs(cum) > distEps + SLACK) {
          fail('区间 ' + (ri + 1) + ' 时刻 ' + s.t + 's：累计里程偏差 ' + cum.toFixed(4) + ' m 超预算 ±' + distEps);
        }
        runRes.maxSpeedErr = Math.max(runRes.maxSpeedErr, err);
        runRes.maxAbsCumDev = Math.max(runRes.maxAbsCumDev, Math.abs(cum));
        if (err > res.maxSpeedErr) res.maxSpeedErr = err;
        if (Math.abs(cum) > res.maxAbsCumDev) res.maxAbsCumDev = Math.abs(cum);
        runRes.samples.push({ t: s.t, vOrig: s.v, vDec, speedErr: err, cumDev: cum });
        while (segIdx < runRes.segments.length - 1 && s.t > runRes.segments[segIdx].t1 + 1e-12) segIdx++;
        const seg = runRes.segments[segIdx];
        if (seg) {
          if (err > seg.maxSpeedErr) seg.maxSpeedErr = err;
          if (Math.abs(cum) > seg.maxAbsCumDev) seg.maxAbsCumDev = Math.abs(cum);
        }
      });
      runRes.segments.forEach((seg, ki) => {
        seg.util = Math.max(utilOf(seg.maxSpeedErr, speedEps), utilOf(seg.maxAbsCumDev, distEps));
        if (!res.worst || seg.util > res.worst.util) {
          res.worst = { runIdx: ri, segIdx: ki, util: seg.util, t0: seg.t0, t1: seg.t1 };
        }
      });
      res.totals.origDist += runRes.origDist;
      res.totals.decDist += runRes.decDist;
    });
    return res;
  }

  return {
    FORMAT, VERSION, UNIT_TO_MPS,
    unitToMps, parseTimeToMs, parseCSV, buildDataset,
    compressRun, compressRuns, exportFile, decodeFile, interpPoints, verify,
  };
});
