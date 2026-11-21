/*
 * smoke-ui.js — 页面级冒烟测试（需要 jsdom；未安装时自动跳过，不影响主测试）。
 * 运行: node test/smoke-ui.js
 * 覆盖：启动加载 → 切换示例 → 冲突修正重算 → 修改预算 → 定位上限段 →
 *       表格视图 → 主题切换 → 下载 → 上传文件独立校验。
 */
'use strict';
const path = require('path');
const fs = require('fs');

let JSDOM;
try {
  JSDOM = require('/tmp/domtest/node_modules/jsdom').JSDOM;
} catch (e) {
  try { JSDOM = require('jsdom').JSDOM; } catch (e2) {
    console.log('SKIP: jsdom 不可用，跳过 UI 冒烟测试');
    process.exit(0);
  }
}

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = path.join(__dirname, '..', 'index.html');
  const dom = await JSDOM.fromFile(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = function () {
        return new Proxy({}, { get: () => () => {}, set: () => true });
      };
      Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 900; }, configurable: true });
      Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 240; }, configurable: true });
      window.Element.prototype.scrollIntoView = function () {};
      window.URL.createObjectURL = () => 'blob:fake';
      window.URL.revokeObjectURL = () => {};
    },
  });
  const { window } = dom;
  const { document } = window;
  await new Promise(r => { window.addEventListener('load', r); setTimeout(r, 1500); });
  await sleep(100);
  const $ = (s) => document.querySelector(s);
  const txt = (s) => ($(s) ? $(s).textContent : '');

  console.log('\n[启动与默认数据]');
  ok(txt('#parseSummary').includes('有效采样 34'), '默认短尖峰数据解析出 34 个采样', txt('#parseSummary'));
  ok(!$('#sec-results').classList.contains('hidden'), '结果区已显示');
  ok(document.querySelectorAll('#tiles .tile').length === 8, '8 个统计卡片');
  ok(txt('#statusBanner').includes('核对通过'), '回读校验通过横幅', txt('#statusBanner').slice(0, 60));
  ok(document.querySelectorAll('#segTable tbody tr').length > 1, '分段明细有数据行');
  ok(txt('#tiles').includes('断点'), '统计卡片含保留断点');

  console.log('\n[切换示例：同刻冲突+停机]');
  const btn = Array.from(document.querySelectorAll('#sampleRow button')).find(b => b.textContent === '同刻冲突+停机');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(!$('#sec-conflicts').classList.contains('hidden'), '冲突隔离区显示');
  ok(txt('#conflictList').includes('已隔离'), '冲突组标记为已隔离');
  ok(txt('#parseSummary').includes('同刻冲突 1 组'), '摘要报告 1 组冲突', txt('#parseSummary'));
  ok(txt('#parseSummary').includes('有效采样 33'), '冲突时刻未进样本（33 个）', txt('#parseSummary'));

  console.log('\n[修正冲突记录并重算]');
  const radio = document.querySelector('#conflictList input[type="radio"]');
  radio.checked = true;
  const applyBtn = Array.from(document.querySelectorAll('#conflictList button')).find(b => b.textContent.includes('修正该组'));
  applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(txt('#conflictList').includes('已修正为'), '冲突组标记为已修正');
  ok(txt('#conflictList').includes('原值'), '原值仍保留展示');
  ok(txt('#parseSummary').includes('有效采样 34'), '修正值进入样本（34 个）', txt('#parseSummary'));
  ok(txt('#statusBanner').includes('核对通过'), '修正后重算核对通过');

  console.log('\n[修改预算重算]');
  const before = txt('#tiles');
  $('#speedEps').value = '5';
  $('#speedEps').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(400);
  ok(txt('#tiles') !== before, '放宽速度预算后统计变化');
  ok(txt('#tiles').includes('±5'), '卡片显示新预算 ±5 m/s', txt('#tiles').slice(0, 200));

  console.log('\n[定位最接近上限的一段]');
  $('#locateBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(document.querySelector('#segTable tr.worst') !== null, '分段表高亮最接近上限的行');
  ok(txt('#segTable').includes('★'), '上限段带 ★ 标记');

  console.log('\n[表格视图]');
  $('#tableToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(!$('#tableArea').classList.contains('hidden'), '表格区显示');
  ok(document.querySelectorAll('#sampleTable tbody tr').length > 30, '逐点核对表有数据行');
  $('#tableToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);

  console.log('\n[主题切换]');
  $('#themeToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok(document.documentElement.getAttribute('data-theme') === 'dark', '切换为深色主题');

  console.log('\n[下载与上传独立校验]');
  let downloaded = null;
  const origCreate = window.URL.createObjectURL;
  window.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:fake'; };
  $('#downloadBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  ok(downloaded !== null, '下载生成了文件 Blob');
  const fileText = await downloaded.text();
  const fileObj = JSON.parse(fileText);
  ok(fileObj.format === 'veh-speed-plc' && fileObj.units && fileObj.params && Array.isArray(fileObj.runs),
    '下载文件包含 format/单位/压缩参数/断点');
  ok(fileObj.runs.every(r => r.breakBefore !== undefined), '文件携带断开口信息');

  const file = new window.File([fileText], 'roundtrip.json', { type: 'application/json' });
  Object.defineProperty($('#verifyInput'), 'files', { value: [file], configurable: true });
  $('#verifyInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(100);
  ok(txt('#verifyResult').includes('核对通过'), '上传文件独立解码核对通过', txt('#verifyResult').slice(0, 120));
  ok(txt('#verifyResult').includes('roundtrip.json'), '显示被校验文件名');

  console.log('\n[篡改文件应被检出]');
  const tampered = JSON.parse(fileText);
  tampered.runs[0].points[1][1] += 5; // 篡改一个断点速度
  const badFile = new window.File([JSON.stringify(tampered)], 'tampered.json', { type: 'application/json' });
  Object.defineProperty($('#verifyInput'), 'files', { value: [badFile], configurable: true });
  $('#verifyInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(100);
  ok(txt('#verifyResult').includes('核对未通过'), '篡改断点后核对未通过', txt('#verifyResult').slice(0, 120));

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('冒烟测试异常：', e); process.exit(1); });
