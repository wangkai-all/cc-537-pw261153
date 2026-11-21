/*
 * app.js — 页面逻辑：导入解析、参数与预算、冲突修正、压缩与文件回读校验、
 * 图表（原始 vs 解码对照、逐点速度误差、累计里程偏差）、分段明细与定位。
 * 依赖 core.js（SpeedCore）与 samples.js（SAMPLES）。
 */
/* global SpeedCore, SAMPLES */
(function () {
  'use strict';
  const Core = SpeedCore;
  const $ = (s) => document.querySelector(s);

  const els = {
    csvInput: $('#csvInput'), fileInput: $('#fileInput'), defaultUnit: $('#defaultUnit'),
    parseBtn: $('#parseBtn'), parseSummary: $('#parseSummary'), sampleRow: $('#sampleRow'),
    speedEps: $('#speedEps'), distEps: $('#distEps'), gapThreshold: $('#gapThreshold'),
    rebuildBtn: $('#rebuildBtn'),
    secConflicts: $('#sec-conflicts'), conflictList: $('#conflictList'),
    secResults: $('#sec-results'), statusBanner: $('#statusBanner'), tiles: $('#tiles'),
    downloadBtn: $('#downloadBtn'), locateBtn: $('#locateBtn'), tableToggle: $('#tableToggle'),
    chartArea: $('#chartArea'), tableArea: $('#tableArea'),
    chSpeed: $('#chSpeed'), chErr: $('#chErr'), chDist: $('#chDist'),
    chartLegend: $('#chartLegend'),
    segTable: $('#segTable'), sampleTable: $('#sampleTable'),
    verifyInput: $('#verifyInput'), verifyResult: $('#verifyResult'),
    themeToggle: $('#themeToggle'),
  };

  const state = {
    records: [], parseErrors: [], fixes: new Map(),
    dataset: null, compressed: null, fileText: '', decoded: null, verification: null,
    params: { speedEps: 0.5, distEps: 20, gapThreshold: 60 },
    xDomain: null, allSamples: [],
    highlight: null, hoverT: null, tableMode: false,
    uploaded: null, // { fileName, size, decoded, verification, usedParams, error }
  };

  /* ---------------- 基础工具 ---------------- */

  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pad2(x) { return String(x).padStart(2, '0'); }
  function fmt(x, d) { return Number(x).toFixed(d == null ? 2 : d); }
  function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtDist(m) {
    const a = Math.abs(m);
    if (a >= 10000) return (m / 1000).toFixed(2) + ' km';
    return m.toFixed(1) + ' m';
  }
  function fmtClock(tAbs) {
    const xd = state.xDomain;
    if (xd && xd.epochLike) {
      const d = new Date(tAbs * 1000);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }
    const s = Math.round(tAbs - (xd ? xd.min : 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(ss) : m + ':' + pad2(ss);
  }
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      surface: g('--surface-1'), ink: g('--text-primary'), ink2: g('--text-secondary'),
      muted: g('--muted'), grid: g('--gridline'), baseline: g('--baseline'),
      s1: g('--series-1'), s2: g('--series-2'),
      critical: g('--status-critical'), good: g('--status-good'),
      wash2: g('--wash-2'), gapWash: g('--gap-wash'),
    };
  }

  /* ---------------- 流程 ---------------- */

  function parseAndLoad(text) {
    const r = Core.parseCSV(text, els.defaultUnit.value);
    state.records = r.records;
    state.parseErrors = r.errors;
    state.fixes = new Map();
    state.uploaded = null;
    rebuild();
  }

  function readParams() {
    const num = (input, fallback) => {
      const v = parseFloat(input.value);
      return isFinite(v) && v >= 0 ? v : fallback;
    };
    state.params = {
      speedEps: num(els.speedEps, state.params.speedEps),
      distEps: num(els.distEps, state.params.distEps),
      gapThreshold: num(els.gapThreshold, state.params.gapThreshold),
    };
  }

  function rebuild() {
    state.dataset = null; state.compressed = null; state.fileText = '';
    state.decoded = null; state.verification = null; state.highlight = null; state.hoverT = null;
    if (state.records.length) {
      state.dataset = Core.buildDataset(state.records, state.params.gapThreshold, state.fixes);
      if (state.dataset.samples.length) {
        state.compressed = Core.compressRuns(state.dataset.runs, state.params.speedEps, state.params.distEps);
        // 压缩 → 序列化为文件文本 → 独立解码器只读文本 → 与原始输入逐点核对
        state.fileText = JSON.stringify(Core.exportFile(state.compressed, state.params), null, 2);
        state.decoded = Core.decodeFile(state.fileText);
        state.verification = Core.verify(state.decoded, state.dataset.runs, state.params.speedEps, state.params.distEps);
        let lo = Infinity, hi = -Infinity;
        const all = [];
        state.verification.runs.forEach((run, ri) => {
          for (const s of run.samples) { all.push({ t: s.t, vOrig: s.vOrig, vDec: s.vDec, speedErr: s.speedErr, cumDev: s.cumDev, runIdx: ri }); }
        });
        for (const s of state.dataset.samples) { if (s.t < lo) lo = s.t; if (s.t > hi) hi = s.t; }
        state.allSamples = all;
        state.xDomain = { min: lo, max: hi, epochLike: lo > 1e8 };
      }
    }
    // 已上传的校验文件与当前原始输入保持一致：重算后同步重新核对
    if (state.uploaded && state.uploaded.decoded) {
      state.uploaded.verification = state.dataset
        ? Core.verify(state.uploaded.decoded, state.dataset.runs,
            state.uploaded.usedParams.speedEps, state.uploaded.usedParams.distEps)
        : null;
    }
    renderAll();
  }

  /* ---------------- 渲染：摘要 / 冲突 / 结果 ---------------- */

  function renderAll() {
    renderParseSummary();
    renderConflicts();
    const hasData = !!(state.dataset && state.dataset.samples.length);
    els.secResults.classList.toggle('hidden', !hasData);
    if (hasData) {
      renderBanner();
      renderTiles();
      renderSegTable();
      renderSampleTable();
      els.chartArea.classList.toggle('hidden', state.tableMode);
      els.tableArea.classList.toggle('hidden', !state.tableMode);
      if (!state.tableMode) renderCharts();
    }
    renderUploaded();
  }

  function renderParseSummary() {
    clear(els.parseSummary);
    els.parseSummary.classList.remove('bad');
    if (!state.records.length && !state.parseErrors.length) {
      els.parseSummary.textContent = '尚未导入数据。';
      return;
    }
    const d = state.dataset;
    const stops = state.records.filter(r => r.stop).length;
    const speedRecs = state.records.length - stops;
    const parts = [
      '记录 ' + speedRecs + ' 条（另有停机标记 ' + stops + ' 个）',
      '有效采样 ' + (d ? d.samples.length : 0) + ' 个',
      '完全重复去重 ' + (d ? d.deduped : 0) + ' 条',
    ];
    const unfixed = d ? d.conflicts.filter(c => !c.fixed) : [];
    const fixedN = d ? d.conflicts.filter(c => c.fixed) : [];
    if (d && d.conflicts.length) {
      parts.push('同刻冲突 ' + d.conflicts.length + ' 组（隔离中 ' + unfixed.length + ' 组，已修正 ' + fixedN.length + ' 组）');
    }
    if (state.parseErrors.length) parts.push('无法解析 ' + state.parseErrors.length + ' 行');
    if (d && d.runs.length) parts.push('连续区间 ' + d.runs.length + ' 个');
    els.parseSummary.append(el('div', { text: parts.join(' · ') }));
    if (state.parseErrors.length) {
      els.parseSummary.classList.add('bad');
      const ul = el('ul', { style: 'margin:4px 0 0;padding-left:18px' });
      state.parseErrors.slice(0, 5).forEach(e => {
        ul.append(el('li', { text: '第 ' + e.line + ' 行：' + e.msg }));
      });
      if (state.parseErrors.length > 5) ul.append(el('li', { text: '……共 ' + state.parseErrors.length + ' 行' }));
      els.parseSummary.append(ul);
    }
    if (d && !d.samples.length) {
      els.parseSummary.append(el('div', { class: 'bad', text: '没有可用采样：全部记录不是冲突隔离中，就是无法解析。' }));
    }
  }

  function renderConflicts() {
    const d = state.dataset;
    clear(els.conflictList);
    els.secConflicts.classList.toggle('hidden', !(d && d.conflicts.length));
    if (!d || !d.conflicts.length) return;
    d.conflicts.forEach((cg, gi) => {
      const box = el('div', { class: 'conflict-group' });
      const tSec = cg.tMs / 1000;
      const title = el('div', { class: 'cg-title' },
        '时刻 t = ' + tSec + ' s（' + fmtClock(tSec) + '）· ' + cg.records.length + ' 条记录速度冲突');
      const status = el('span', {
        class: 'cg-status ' + (cg.fixed ? 'fixed' : 'isolated'),
        text: cg.fixed ? '✓ 已修正为 ' + fmt(cg.fixValue, 4) + ' m/s（原值保留如下）' : '✗ 已隔离，未参与压缩',
      });
      title.append(status);
      box.append(title);
      const name = 'cg-' + gi;
      cg.records.forEach(r => {
        const radio = el('input', { type: 'radio', name });
        radio.value = String(r.line);
        if (cg.fixed && cg.fixLine === r.line) radio.checked = true;
        const label = el('label', {},
          radio,
          el('span', { text: '第 ' + r.line + ' 行：' + r.rawV + ' ' + (r.unit || '') + '（= ' + fmt(r.v, 4) + ' m/s）' }),
          el('span', { class: 'orig', text: '原值' }));
        box.append(label);
      });
      const valueInput = el('input', { class: 'cg-value', type: 'number', step: '0.01', placeholder: '留空=所选原值' });
      const applyBtn = el('button', {
        class: 'small primary', type: 'button',
        onclick: () => {
          const checked = box.querySelector('input[name="' + name + '"]:checked');
          if (!checked) { window.alert('请先选择要保留的记录'); return; }
          const line = Number(checked.value);
          const rec = cg.records.find(r => r.line === line);
          let value = rec.v;
          if (valueInput.value.trim() !== '') {
            const nv = Number(valueInput.value);
            if (!isFinite(nv)) { window.alert('修正值不是数字'); return; }
            value = nv;
          }
          state.fixes.set(cg.tMs, { line, value });
          rebuild();
        },
      }, '修正该组并重算');
      const fixRow = el('div', { class: 'fix-row' },
        el('span', { text: '修正值（m/s）：' }), valueInput, applyBtn);
      if (cg.fixed) {
        fixRow.append(el('button', {
          class: 'small', type: 'button',
          onclick: () => { state.fixes.delete(cg.tMs); rebuild(); },
        }, '撤销修正（回到隔离）'));
      }
      box.append(fixRow);
      els.conflictList.append(box);
    });
  }

  function renderBanner() {
    const v = state.verification;
    clear(els.statusBanner);
    const n = state.dataset.samples.length;
    const p = state.params;
    if (v.ok) {
      els.statusBanner.append(el('div', { class: 'banner good' },
        el('span', { class: 'icon', text: '✓' }),
        el('div', {},
          el('div', { text: '独立解码器回读导出文件，与原始输入逐点核对通过：' + n + ' 个采样点的速度误差与累计里程偏差均在预算内。' }),
          el('div', { class: 'footnote', text: '预算：速度 ±' + p.speedEps + ' m/s · 里程 ±' + p.distEps + ' m · 缺口阈值 ' + p.gapThreshold + ' s' }))));
    } else {
      const box = el('div', { class: 'banner bad' }, el('span', { class: 'icon', text: '✗' }));
      const inner = el('div', {}, el('div', { text: '核对未通过：' + v.problems.length + ' 处超限或不一致（前几条如下）。' }));
      const ul = el('ul');
      v.problems.slice(0, 5).forEach(m => ul.append(el('li', { text: m })));
      inner.append(ul);
      box.append(inner);
      els.statusBanner.append(box);
    }
  }

  function renderTiles() {
    const v = state.verification;
    const d = state.dataset;
    const p = state.params;
    const nPts = state.compressed.reduce((a, r) => a + r.points.length, 0);
    const nSamples = d.samples.length;
    const bytes = new Blob([state.fileText]).size;
    clear(els.tiles);
    const tile = (label, value, sub) => el('div', { class: 'tile' },
      el('div', { class: 't-label', text: label }),
      el('div', { class: 't-value', text: value }),
      sub ? el('div', { class: 't-sub', text: sub }) : null);
    els.tiles.append(
      tile('原始采样点', String(nSamples), '隔离冲突未计入'),
      tile('保留断点', String(nPts), '连续区间 ' + d.runs.length + ' 个'),
      tile('压缩率', fmtPct(1 - nPts / nSamples), nSamples + ' → ' + nPts + ' 点'),
      tile('文件体积', fmtBytes(bytes), '实际 JSON 字节数'),
      tile('最大速度误差', fmt(v.maxSpeedErr, 4) + ' m/s', '预算 ±' + p.speedEps + ' · 利用率 ' + fmtPct(v.maxSpeedErr / (p.speedEps || Infinity))),
      tile('最大累计里程偏差', fmt(v.maxAbsCumDev, 3) + ' m', '预算 ±' + p.distEps + ' · 利用率 ' + fmtPct(v.maxAbsCumDev / (p.distEps || Infinity))),
      tile('原始里程', fmtDist(v.totals.origDist), '仅连续区间梯形积分'),
      tile('解码里程', fmtDist(v.totals.decDist), '差值 ' + fmt(v.totals.decDist - v.totals.origDist, 2) + ' m'),
    );
  }

  function breakText(bb) {
    if (!bb) return '';
    if (bb.reason === 'stop') return '断开口：停机标记 @ ' + fmtClock(bb.at);
    return '断开口：采样缺口 ' + Math.round(bb.gapSeconds) + ' s';
  }

  function renderSegTable() {
    const v = state.verification;
    const p = state.params;
    clear(els.segTable);
    const thead = el('thead');
    const hr = el('tr');
    ['段', '区间（相对时间）', '时长', '覆盖采样点', '最大速度误差(m/s)', '最大|累计里程偏差|(m)', '速度利用率', '里程利用率', '综合'].forEach(h => hr.append(el('th', { text: h })));
    thead.append(hr);
    const tbody = el('tbody');
    v.runs.forEach((run, ri) => {
      const comp = state.compressed[ri];
      const head = el('tr', { class: 'run-head' });
      const bb = state.dataset.runs[ri].breakBefore;
      head.append(el('td', {
        colspan: '9',
        text: '连续区间 ' + (ri + 1) + ' · ' + comp.points.length + ' 个断点 · 覆盖 ' + comp.sourceCount + ' 个采样' +
          (bb ? ' · ' + breakText(bb) : ''),
      }));
      tbody.append(head);
      if (!run.segments.length) {
        const tr = el('tr');
        tr.append(el('td', { colspan: '9', text: '单点区间，无分段' }));
        tbody.append(tr);
        return;
      }
      run.segments.forEach((seg, ki) => {
        const isWorst = v.worst && v.worst.runIdx === ri && v.worst.segIdx === ki;
        const tr = el('tr', { id: 'segrow-' + ri + '-' + ki, class: isWorst ? 'worst' : '' });
        const cov = comp.segments[ki] ? (comp.segments[ki].i1 - comp.segments[ki].i0 + 1) : '-';
        const uS = seg.maxSpeedErr / (p.speedEps || Infinity);
        const uD = seg.maxAbsCumDev / (p.distEps || Infinity);
        [String(ki + 1) + (isWorst ? ' ★' : ''),
         fmtClock(seg.t0) + ' – ' + fmtClock(seg.t1),
         fmt(seg.t1 - seg.t0, 1) + ' s',
         String(cov),
         fmt(seg.maxSpeedErr, 4),
         fmt(seg.maxAbsCumDev, 3),
         fmtPct(uS), fmtPct(uD), fmtPct(seg.util),
        ].forEach((txt, ci) => tr.append(el('td', { class: ci >= 2 ? 'num' : '', text: txt })));
        tbody.append(tr);
      });
    });
    els.segTable.append(thead, tbody);
  }

  function renderSampleTable() {
    clear(els.sampleTable);
    const thead = el('thead');
    const hr = el('tr');
    ['区间', '时刻', '原始速度(m/s)', '解码速度(m/s)', '速度误差(m/s)', '累计里程偏差(m)'].forEach(h => hr.append(el('th', { text: h })));
    thead.append(hr);
    const tbody = el('tbody');
    const CAP = 2000;
    let shown = 0, total = 0;
    state.verification.runs.forEach((run, ri) => {
      for (const s of run.samples) {
        total++;
        if (shown >= CAP) continue;
        shown++;
        const tr = el('tr');
        [String(ri + 1), fmtClock(s.t), fmt(s.vOrig, 4), fmt(s.vDec, 4), fmt(s.speedErr, 4), fmt(s.cumDev, 3)]
          .forEach((txt, ci) => tr.append(el('td', { class: ci >= 2 ? 'num' : '', text: txt })));
        tbody.append(tr);
      }
    });
    if (total > CAP) {
      const tr = el('tr');
      tr.append(el('td', { colspan: '6', text: '……共 ' + total + ' 行，仅显示前 ' + CAP + ' 行' }));
      tbody.append(tr);
    }
    els.sampleTable.append(thead, tbody);
  }

  /* ---------------- 图表 ---------------- */

  const chartGeom = new Map();

  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let x = lo; x <= hi + step * 1e-9; x += step) ticks.push(x);
    return { ticks, lo, hi, step };
  }

  function fmtTick(v, step) {
    const dec = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    const val = Math.abs(v) < step * 1e-9 ? 0 : v;
    return val.toFixed(dec);
  }

  function drawChart(canvas, cfg) {
    const wrap = canvas.parentElement;
    const cssW = wrap.clientWidth;
    if (cssW < 60) return;
    const cssH = cfg.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = themeColors();
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, cssW, cssH);

    const M = { l: 56, r: 14, t: 14, b: 26 };
    const pw = cssW - M.l - M.r, ph = cssH - M.t - M.b;
    const xd = state.xDomain;
    const yT = niceTicks(cfg.yMin, cfg.yMax, 4);
    const X = (t) => M.l + (t - xd.min) / ((xd.max - xd.min) || 1) * pw;
    const Y = (v) => M.t + (yT.hi - v) / ((yT.hi - yT.lo) || 1) * ph;
    chartGeom.set(canvas, { M, pw, ph });

    // 网格与坐标轴（细实线、低对比）
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    yT.ticks.forEach(tv => {
      const y = Y(tv);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + pw, y); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtTick(tv, yT.step), M.l - 6, y);
    });
    const xT = niceTicks(xd.min, xd.max, 6);
    xT.ticks.forEach(tv => {
      const x = X(tv);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + ph); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(fmtClock(tv), x, M.t + ph + 6);
    });
    ctx.strokeStyle = C.baseline;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, M.t + ph); ctx.lineTo(M.l + pw, M.t + ph); ctx.stroke();

    // 断开口（缺口 / 停机）色带
    (cfg.bands || []).forEach(b => {
      const x0 = X(Math.max(b.x0, xd.min)), x1 = X(Math.min(b.x1, xd.max));
      if (x1 <= x0) return;
      ctx.fillStyle = C.gapWash;
      ctx.fillRect(x0, M.t, x1 - x0, ph);
      if (x1 - x0 > 34) {
        ctx.fillStyle = C.muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(b.label, (x0 + x1) / 2, M.t + 3);
      }
    });

    // 定位高亮（最接近上限的一段）
    if (state.highlight) {
      const x0 = X(state.highlight.t0), x1 = X(state.highlight.t1);
      ctx.fillStyle = C.wash2;
      ctx.fillRect(x0, M.t, Math.max(2, x1 - x0), ph);
      ctx.strokeStyle = C.s2;
      ctx.beginPath(); ctx.moveTo(x0, M.t); ctx.lineTo(x0, M.t + ph); ctx.moveTo(x1, M.t); ctx.lineTo(x1, M.t + ph); ctx.stroke();
    }

    // 零线
    if (cfg.zeroLine && yT.lo < 0 && yT.hi > 0) {
      ctx.strokeStyle = C.baseline;
      ctx.beginPath(); ctx.moveTo(M.l, Y(0)); ctx.lineTo(M.l + pw, Y(0)); ctx.stroke();
    }

    // 预算上限线（状态色 + 文字标签）
    (cfg.limitLines || []).forEach(L => {
      const y = Y(L.y);
      if (y < M.t || y > M.t + ph) return;
      ctx.strokeStyle = C.critical;
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + pw, y); ctx.stroke();
      ctx.strokeStyle = C.critical;
      ctx.beginPath(); ctx.moveTo(M.l + 4, y - 3); ctx.lineTo(M.l + 16, y - 3); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(L.label, M.l + 20, y - 2);
    });

    // 数据序列（按连续区间分别连线，跨区间不连）
    cfg.series.forEach(s => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      s.runs.forEach(run => {
        if (!run.length) return;
        ctx.beginPath();
        ctx.moveTo(X(run[0].x), Y(run[0].y));
        for (let i = 1; i < run.length; i++) ctx.lineTo(X(run[i].x), Y(run[i].y));
        ctx.stroke();
      });
    });

    // 标记点（断点 / 超限点）：r=4，表面色 2px 圆环
    (cfg.markers || []).forEach(m => {
      ctx.beginPath();
      ctx.arc(X(m.x), Y(m.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.surface;
      ctx.stroke();
    });

    // 悬停十字线
    if (state.hoverT != null && cfg.hoverDots) {
      const x = X(state.hoverT);
      ctx.strokeStyle = C.muted;
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + ph); ctx.stroke();
      cfg.hoverDots.forEach(d => {
        ctx.beginPath();
        ctx.arc(X(d.x), Y(d.y), 3.5, 0, Math.PI * 2);
        ctx.fillStyle = d.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = C.surface;
        ctx.stroke();
      });
    }
  }

  function gapBands() {
    const bands = [];
    const runs = state.dataset.runs;
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1].samples, cur = runs[i].samples;
      const bb = runs[i].breakBefore;
      bands.push({
        x0: prev[prev.length - 1].t,
        x1: cur[0].t,
        label: bb && bb.reason === 'stop' ? '停机' : '缺口 ' + Math.round(bb ? bb.gapSeconds : 0) + 's',
      });
    }
    return bands;
  }

  function renderCharts() {
    if (!state.verification || !state.xDomain) return;
    const C = themeColors();
    const v = state.verification;
    const p = state.params;
    const bands = gapBands();
    const hover = state.hoverT != null ? nearestSample(state.hoverT) : null;

    // 速度对照：原始（蓝）vs 文件解码（橙），断点标记
    const speedOrig = [], speedDec = [], bpMarkers = [];
    let vLo = Infinity, vHi = -Infinity;
    v.runs.forEach((run, ri) => {
      speedOrig.push(run.samples.map(s => ({ x: s.t, y: s.vOrig })));
      const pts = state.decoded.runs[ri].points;
      speedDec.push(pts.map(pt => ({ x: pt.t, y: pt.v })));
      pts.forEach(pt => bpMarkers.push({ x: pt.t, y: pt.v, color: C.s2 }));
      run.samples.forEach(s => { if (s.vOrig < vLo) vLo = s.vOrig; if (s.vOrig > vHi) vHi = s.vOrig; });
      pts.forEach(pt => { if (pt.v < vLo) vLo = pt.v; if (pt.v > vHi) vHi = pt.v; });
    });
    const vPad = ((vHi - vLo) || 1) * 0.06;
    drawChart(els.chSpeed, {
      height: 240, yMin: vLo - vPad, yMax: vHi + vPad, bands,
      series: [
        { color: C.s1, runs: speedOrig },
        { color: C.s2, runs: speedDec },
      ],
      markers: bpMarkers,
      hoverDots: hover ? [
        { x: hover.t, y: hover.vOrig, color: C.s1 },
        { x: hover.t, y: hover.vDec, color: C.s2 },
      ] : null,
    });

    // 逐点速度误差 + 预算线
    const errRuns = [];
    let errMax = 0;
    const errOver = [];
    v.runs.forEach(run => {
      errRuns.push(run.samples.map(s => ({ x: s.t, y: s.speedErr })));
      run.samples.forEach(s => {
        if (s.speedErr > errMax) errMax = s.speedErr;
        if (s.speedErr > p.speedEps + 1e-9) errOver.push({ x: s.t, y: s.speedErr, color: C.critical });
      });
    });
    drawChart(els.chErr, {
      height: 170, yMin: 0, yMax: Math.max(errMax, p.speedEps, 1e-6) * 1.12, bands,
      series: [{ color: C.s1, runs: errRuns }],
      markers: errOver,
      limitLines: [{ y: p.speedEps, label: '速度预算 ±' + p.speedEps + ' m/s' }],
      hoverDots: hover ? [{ x: hover.t, y: hover.speedErr, color: C.s1 }] : null,
    });

    // 累计有符号里程偏差 + 双侧预算线
    const devRuns = [];
    let dLo = 0, dHi = 0;
    const devOver = [];
    v.runs.forEach(run => {
      devRuns.push(run.samples.map(s => ({ x: s.t, y: s.cumDev })));
      run.samples.forEach(s => {
        if (s.cumDev < dLo) dLo = s.cumDev;
        if (s.cumDev > dHi) dHi = s.cumDev;
        if (Math.abs(s.cumDev) > p.distEps + 1e-9) devOver.push({ x: s.t, y: s.cumDev, color: C.critical });
      });
    });
    const dPad = ((dHi - dLo) || 1) * 0.08;
    drawChart(els.chDist, {
      height: 170,
      yMin: Math.min(dLo, -p.distEps) - dPad, yMax: Math.max(dHi, p.distEps) + dPad,
      bands, zeroLine: true,
      series: [{ color: C.s1, runs: devRuns }],
      markers: devOver,
      limitLines: [
        { y: p.distEps, label: '里程预算 ±' + p.distEps + ' m' },
        { y: -p.distEps },
      ],
      hoverDots: hover ? [{ x: hover.t, y: hover.cumDev, color: C.s1 }] : null,
    });

    // 时间轴说明
    let note = document.getElementById('timeBaseNote');
    if (!note) {
      note = el('div', { class: 'footnote', id: 'timeBaseNote' });
      els.chartArea.appendChild(note);
    }
    const t0 = state.xDomain.min;
    note.textContent = state.xDomain.epochLike
      ? '时间轴：绝对时刻（起点 ' + new Date(t0 * 1000).toLocaleString('zh-CN') + '）'
      : '时间轴：相对时间（起点 t = ' + t0 + ' s）';
  }

  function nearestSample(t) {
    const arr = state.allSamples;
    if (!arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid; else hi = mid;
    }
    return (t - arr[lo].t <= arr[hi].t - t) ? arr[lo] : arr[hi];
  }

  const tooltip = (() => {
    const node = el('div', { class: 'tooltip hidden' });
    document.body.appendChild(node);
    return node;
  })();

  function showTooltip(sample, clientX, clientY) {
    clear(tooltip);
    const C = themeColors();
    tooltip.append(el('div', { class: 'tt-title', text: '时刻 ' + fmtClock(sample.t) + '（区间 ' + (sample.runIdx + 1) + '）' }));
    const row = (key, color, val) => el('div', { class: 'tt-row' },
      el('span', { class: 'k' }, el('span', { class: 'line-key', style: 'border-color:' + color }), key),
      el('span', { class: 'v', text: val }));
    tooltip.append(
      row('原始速度', C.s1, fmt(sample.vOrig, 3) + ' m/s'),
      row('解码速度', C.s2, fmt(sample.vDec, 3) + ' m/s'),
      row('速度误差', C.s1, fmt(sample.speedErr, 4) + ' m/s'),
      row('累计里程偏差', C.s1, fmt(sample.cumDev, 3) + ' m'),
    );
    tooltip.classList.remove('hidden');
    const w = 210, h = 130;
    let x = clientX + 14, y = clientY + 14;
    if (x + w > window.innerWidth) x = clientX - w - 10;
    if (y + h > window.innerHeight) y = clientY - h - 10;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() { tooltip.classList.add('hidden'); }

  function onChartPointerMove(e) {
    if (!state.verification || !state.xDomain) return;
    const geom = chartGeom.get(e.currentTarget);
    if (!geom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xd = state.xDomain;
    const t = xd.min + (px - geom.M.l) / geom.pw * ((xd.max - xd.min) || 1);
    const sample = nearestSample(t);
    if (!sample) return;
    state.hoverT = sample.t;
    renderCharts();
    showTooltip(sample, e.clientX, e.clientY);
  }

  function onChartPointerLeave() {
    state.hoverT = null;
    hideTooltip();
    renderCharts();
  }

  /* ---------------- 上传文件独立校验 ---------------- */

  function renderUploaded() {
    clear(els.verifyResult);
    const u = state.uploaded;
    if (!u) {
      els.verifyResult.textContent = '解码器只读取文件内容（单位、断点、压缩参数），再与当前第 1 区的原始输入逐点核对。';
      return;
    }
    if (u.error) {
      els.verifyResult.append(el('div', { class: 'banner bad' },
        el('span', { class: 'icon', text: '✗' }),
        el('div', { text: '文件无法解码：' + u.error })));
      return;
    }
    const meta = u.decoded.meta;
    const nPts = u.decoded.runs.reduce((a, r) => a + r.points.length, 0);
    els.verifyResult.append(el('div', { class: 'verify-meta' },
      el('div', { text: '文件：' + u.fileName + '（' + fmtBytes(u.size) + '）· 生成于 ' + (meta.generatedAt || '未知') }),
      el('div', {
        text: '文件声明：单位 时间=' + meta.units.time + ' 速度=' + meta.units.speed + ' 里程=' + meta.units.distance +
          ' · 参数 速度预算 ±' + u.usedParams.speedEps + ' m/s、里程预算 ±' + u.usedParams.distEps + ' m、缺口阈值 ' + u.usedParams.gapThreshold + ' s' +
          ' · 连续区间 ' + u.decoded.runs.length + ' 个 · 断点 ' + nPts + ' 个',
      })));
    const v = u.verification;
    if (!v) {
      els.verifyResult.append(el('div', { class: 'verify-meta', text: '请先在第 1 区导入对应的原始数据，才能逐点核对。' }));
      return;
    }
    if (v.ok) {
      els.verifyResult.append(el('div', { class: 'banner good' },
        el('span', { class: 'icon', text: '✓' }),
        el('div', { text: '核对通过：最大速度误差 ' + fmt(v.maxSpeedErr, 4) + ' m/s，最大累计里程偏差 ' + fmt(v.maxAbsCumDev, 3) +
          ' m，均在文件声明的预算内。原始里程 ' + fmtDist(v.totals.origDist) + '，解码里程 ' + fmtDist(v.totals.decDist) + '。' })));
    } else {
      const box = el('div', { class: 'banner bad' }, el('span', { class: 'icon', text: '✗' }));
      const inner = el('div', {}, el('div', { text: '核对未通过（' + v.problems.length + ' 处）：' }));
      const ul = el('ul');
      v.problems.slice(0, 5).forEach(m => ul.append(el('li', { text: m })));
      inner.append(ul);
      box.append(inner);
      els.verifyResult.append(box);
    }
  }

  /* ---------------- 事件 ---------------- */

  function initEvents() {
    els.parseBtn.addEventListener('click', () => parseAndLoad(els.csvInput.value));
    els.fileInput.addEventListener('change', () => {
      const f = els.fileInput.files && els.fileInput.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { els.csvInput.value = String(rd.result); parseAndLoad(els.csvInput.value); };
      rd.readAsText(f);
    });
    els.defaultUnit.addEventListener('change', () => { if (els.csvInput.value.trim()) parseAndLoad(els.csvInput.value); });

    let debounce = null;
    const onParam = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { readParams(); rebuild(); }, 250);
    };
    [els.speedEps, els.distEps, els.gapThreshold].forEach(i => i.addEventListener('input', onParam));
    els.rebuildBtn.addEventListener('click', () => { readParams(); rebuild(); });

    els.downloadBtn.addEventListener('click', () => {
      if (!state.fileText) return;
      const blob = new Blob([state.fileText], { type: 'application/json' });
      const a = el('a', {
        href: URL.createObjectURL(blob),
        download: 'speed-plc-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json',
      });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    });

    els.locateBtn.addEventListener('click', () => {
      const w = state.verification && state.verification.worst;
      if (!w) return;
      state.highlight = { t0: w.t0, t1: w.t1 };
      if (state.tableMode) { // 切回图表看高亮
        state.tableMode = false;
        els.tableToggle.textContent = '切换为表格视图';
        els.tableToggle.setAttribute('aria-pressed', 'false');
        els.chartArea.classList.remove('hidden');
        els.tableArea.classList.add('hidden');
      }
      renderCharts();
      renderSegTable();
      const row = document.getElementById('segrow-' + w.runIdx + '-' + w.segIdx);
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    els.tableToggle.addEventListener('click', () => {
      state.tableMode = !state.tableMode;
      els.tableToggle.textContent = state.tableMode ? '切换为图表视图' : '切换为表格视图';
      els.tableToggle.setAttribute('aria-pressed', String(state.tableMode));
      els.chartArea.classList.toggle('hidden', state.tableMode);
      els.tableArea.classList.toggle('hidden', !state.tableMode);
      if (!state.tableMode) renderCharts();
    });

    els.verifyInput.addEventListener('change', () => {
      const f = els.verifyInput.files && els.verifyInput.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const text = String(rd.result);
        try {
          const decoded = Core.decodeFile(text); // 独立解码器：只读文件
          const fp = decoded.meta.params || {};
          const usedParams = {
            speedEps: isFinite(fp.speedEps) ? fp.speedEps : state.params.speedEps,
            distEps: isFinite(fp.distEps) ? fp.distEps : state.params.distEps,
            gapThreshold: isFinite(fp.gapThreshold) ? fp.gapThreshold : state.params.gapThreshold,
          };
          const verification = state.dataset
            ? Core.verify(decoded, state.dataset.runs, usedParams.speedEps, usedParams.distEps)
            : null;
          state.uploaded = { fileName: f.name, size: f.size, decoded, verification, usedParams };
        } catch (err) {
          state.uploaded = { fileName: f.name, size: f.size, error: String(err && err.message || err) };
        }
        renderUploaded();
      };
      rd.readAsText(f);
    });

    [els.chSpeed, els.chErr, els.chDist].forEach(c => {
      c.addEventListener('pointermove', onChartPointerMove);
      c.addEventListener('pointerleave', onChartPointerLeave);
    });

    els.themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (dark ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', next);
      els.themeToggle.textContent = next === 'dark' ? '切换浅色' : '切换深色';
      renderCharts();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderCharts());

    if (window.ResizeObserver) {
      let raf = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { if (!state.tableMode) renderCharts(); });
      }).observe(els.chartArea);
    }
  }

  function initSamples() {
    Object.keys(SAMPLES).forEach(key => {
      const s = SAMPLES[key];
      els.sampleRow.append(el('button', {
        class: 'small', type: 'button', title: s.desc,
        onclick: () => { els.csvInput.value = s.csv; parseAndLoad(s.csv); },
      }, s.name));
    });
  }

  function initLegend() {
    const item = (html) => el('span', { class: 'key' }, html);
    const lineKey = (cssVar) => {
      const n = el('span', { class: 'line-key' });
      n.style.borderColor = 'var(' + cssVar + ')';
      return n;
    };
    const dotKey = (cssVar) => {
      const n = el('span', { class: 'dot-key' });
      n.style.background = 'var(' + cssVar + ')';
      return n;
    };
    els.chartLegend.append(
      item(lineKey('--series-1')), el('span', { text: '原始速度' }),
      item(lineKey('--series-2')), el('span', { text: '解码速度（来自文件）' }),
      item(dotKey('--series-2')), el('span', { text: '保留断点' }),
    );
  }

  /* ---------------- 启动 ---------------- */

  readParams();
  initSamples();
  initLegend();
  initEvents();
  els.csvInput.value = SAMPLES.spike.csv;
  parseAndLoad(SAMPLES.spike.csv);
})();
