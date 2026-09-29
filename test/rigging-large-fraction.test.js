// 吊挂布景载荷核算「多件分数分担叠加」显示失真的回归测试：
// 同一左吊点连接 140 个间距各异（质数厘米）的右吊点，每件 1 kg、重心距右吊点 1 cm、
// 同时生效——左吊点累计载荷为 140 个 1/p 之和，分子 / 分母达数百位。
// 1. /api/rigging 的 {num, den, kg} 中 kg 必须是有限数值（旧实现把巨大分子分母
//    转成浮点数得到 Infinity / Infinity = NaN，JSON 序列化为 null，页面显示 NaN）；
// 2. 峰值、超额区间峰值、超额量、逐件分担的 num/den 与独立 BigInt 核算完全一致，
//    kg 等于精确分数的四舍五入（半数进位）2 位小数；
// 3. 半开时段、严格超额判定与「恰好等于额定载荷不报超额」行为不变；
// 4. 恰好落在 .xx5 边界的分数按精确分数舍入（浮点路径会少进 0.01）。
//
// 运行：node --test（Node >= 18），使用独立临时 DATA_DIR，不污染仓库内 data/。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rigging-frac-'));
process.env.DATA_DIR = TMP_DIR;

const routes = require('../src/routes');
const express = require('express');

let server;

function request(method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          if (raw) {
            try {
              json = JSON.parse(raw);
            } catch {
              /* 无响应体 */
            }
          }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** 前 n 个质数 */
function primes(n) {
  const ps = [];
  let x = 2;
  while (ps.length < n) {
    if (ps.every((p) => x % p !== 0)) ps.push(x);
    x++;
  }
  return ps;
}

function gcdBig(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** 独立精确核算：分数加法（BigInt，约分） */
function addFrac(a, b) {
  let n = a.n * b.d + b.n * a.d;
  let d = a.d * b.d;
  if (n === 0n) return { n: 0n, d: 1n };
  const g = gcdBig(n, d);
  return { n: n / g, d: d / g };
}

/** 独立精确舍入：round(n/d × 100) / 100（半数进位），与服务端口径一致 */
function roundTo2(f) {
  const q = (200n * f.n + f.d) / (2n * f.d); // 非负分数，截断除法即向下取整
  return Number(q) / 100;
}

/** 递归收集响应中的全部 {num, den, kg} 载荷对象 */
function collectLoads(node, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) collectLoads(v, out);
  } else if (node && typeof node === 'object') {
    if ('num' in node && 'den' in node && 'kg' in node) out.push(node);
    else for (const v of Object.values(node)) collectLoads(v, out);
  }
  return out;
}

const PRIMES = primes(140);
let leftPointId;

test('搭建 140 个质数间距右吊点场景（API 逐条写入，含校验）', async () => {
  // 数据目录由种子初始化（自带演示吊点 / 吊挂件），先清空吊挂数据再搭建复现场景
  const data = await request('GET', '/api/data');
  for (const it of data.json.rigItems) {
    assert.strictEqual((await request('DELETE', `/api/rigItems/${it.id}`)).status, 204);
  }
  for (const p of data.json.rigPoints) {
    assert.strictEqual((await request('DELETE', `/api/rigPoints/${p.id}`)).status, 204);
  }
  const left = await request('POST', '/api/rigPoints', { name: '总左吊点', x: 0, ratedLoad: 2 });
  assert.strictEqual(left.status, 201);
  leftPointId = left.json.id;
  for (let i = 0; i < PRIMES.length; i++) {
    const p = PRIMES[i];
    const rp = await request('POST', '/api/rigPoints', { name: `右吊点${i}`, x: p, ratedLoad: 100 });
    assert.strictEqual(rp.status, 201);
    // 每件 1 kg，重心距右吊点 1 cm（cogX = p - 1），同时生效 [0, 100)
    const it = await request('POST', '/api/rigItems', {
      name: `吊挂件${i}`,
      weight: 1,
      cogX: p - 1,
      leftPointId,
      rightPointId: rp.json.id,
      start: 0,
      end: 100,
    });
    assert.strictEqual(it.status, 201);
  }
});

test('大分数叠加：kg 全部为有限数值，num/den 与独立 BigInt 核算一致', async () => {
  const res = await request('GET', '/api/rigging');
  assert.strictEqual(res.status, 200);

  // 响应中所有载荷对象的 kg 均为有限数（不得为 null / NaN）
  const loads = collectLoads(res.json);
  assert.ok(loads.length > 400, `应收集到大量载荷对象，实际 ${loads.length}`);
  for (const f of loads) {
    assert.strictEqual(typeof f.kg, 'number', `kg 必须是数值：${JSON.stringify(f).slice(0, 80)}`);
    assert.ok(Number.isFinite(f.kg), `kg 必须有限：${JSON.stringify(f).slice(0, 80)}`);
    assert.ok(typeof f.num === 'string' && typeof f.den === 'string', 'num/den 保持字符串结构');
  }

  // 左吊点峰值 = sum(1/p)，独立 BigInt 核算比对
  let sum = { n: 0n, d: 1n };
  for (const p of PRIMES) sum = addFrac(sum, { n: 1n, d: BigInt(p) });
  const left = res.json.points.find((p) => p.id === leftPointId);
  assert.strictEqual(left.peak.num, sum.n.toString(), '峰值分子须为精确分数');
  assert.strictEqual(left.peak.den, sum.d.toString(), '峰值分母须为精确分数');
  assert.ok(left.peak.num.length > 300, '分子确实长达数百位（复现条件）');
  assert.strictEqual(left.peak.kg, roundTo2(sum), 'kg 须等于精确分数的 2 位小数舍入');

  // 严格超额判定：sum(1/p) ≈ 2.036 > 额定 2 → 超额区间 [0, 100)，超额量 = 峰值 − 2
  assert.strictEqual(left.overloaded, true);
  assert.strictEqual(left.intervals.length, 1);
  const iv = left.intervals[0];
  assert.strictEqual(iv.start, 0);
  assert.strictEqual(iv.end, 100);
  assert.strictEqual(iv.durationSeconds, 100);
  assert.strictEqual(iv.peakLoad.num, sum.n.toString());
  assert.strictEqual(iv.peakLoad.kg, roundTo2(sum));
  const excess = addFrac(sum, { n: -2n, d: 1n });
  assert.strictEqual(iv.excess.num, excess.n.toString());
  assert.strictEqual(iv.excess.den, excess.d.toString());
  assert.strictEqual(iv.excess.kg, roundTo2(excess));

  // 逐件分担：左分担 1/p、右分担 (p−1)/p，kg 均为精确舍入的有限值
  for (let i = 0; i < PRIMES.length; i++) {
    const item = res.json.items.find((x) => x.name === `吊挂件${i}`);
    const p = BigInt(PRIMES[i]);
    assert.strictEqual(item.leftShare.num, '1');
    assert.strictEqual(item.leftShare.den, p.toString());
    assert.strictEqual(item.leftShare.kg, roundTo2({ n: 1n, d: p }));
    assert.strictEqual(item.rightShare.num, (p - 1n).toString());
    assert.strictEqual(item.rightShare.den, p.toString());
    assert.strictEqual(item.rightShare.kg, roundTo2({ n: p - 1n, d: p }));
  }

  // 汇总计数正确（数据刷新后状态正常）
  assert.strictEqual(res.json.summary.items, 140);
  assert.strictEqual(res.json.summary.overloadedPoints, 1);
  assert.strictEqual(res.json.summary.overloadIntervals, 1);
});

test('半开时段与「恰好等于额定载荷不判超额」行为不变', async () => {
  // 在 140 件场景之上追加：t=100 恰好开始的另一件不与 [0,100) 叠加（同秒结束先于开始）
  const rp = await request('POST', '/api/rigPoints', { name: '半开右点', x: 4, ratedLoad: 100 });
  const it = await request('POST', '/api/rigItems', {
    name: '半开接续件',
    weight: 1,
    cogX: 3,
    leftPointId,
    rightPointId: rp.json.id,
    start: 100,
    end: 200,
  });
  assert.strictEqual(it.status, 201);
  const res = await request('GET', '/api/rigging');
  const left = res.json.points.find((p) => p.id === leftPointId);
  // 左吊点载荷分段：[0,100) 为 sum(1/p)，[100,200) 仅 1/4 —— 若同秒叠加会出现第二段超额
  assert.strictEqual(left.intervals.length, 1, 't=100 开始的吊挂件不得与 t=100 结束的叠加');
  assert.strictEqual(left.intervals[0].end, 100);
  assert.strictEqual(left.peakInterval.start, 0);
  assert.strictEqual(left.peakInterval.end, 100);

  // 种子数据演示（三件各分担 100/3，累计恰好等于额定 100）依旧不判超额：
  // 本测试数据目录由种子初始化，此处直接验证该口径未被本轮修改影响
  const seed = require('../seed/sample-data.json');
  const { analyzeRigging } = require('../src/rigging');
  const seedRes = analyzeRigging(seed);
  const g = seedRes.points.find((p) => p.id === 'rig-g');
  assert.strictEqual(g.peak.num, '100');
  assert.strictEqual(g.peak.den, '1');
  assert.strictEqual(g.peak.kg, 100);
  assert.strictEqual(g.overloaded, false, '累计恰好等于额定载荷不得报超额');
  assert.strictEqual(g.intervals.length, 0);
});

test('恰好 .xx5 边界的分数按精确分数舍入（半数进位），不走浮点路径', async () => {
  // 右分担 = 136296 × 1 / 4800 = 28.395（十进制精确）：精确舍入为 28.40，
  // 旧浮点路径 Number(136296)/Number(4800) 存储为 28.394999… 会误舍为 28.39
  const a = await request('POST', '/api/rigPoints', { name: '边界左点', x: 0, ratedLoad: 1000000 });
  const b = await request('POST', '/api/rigPoints', { name: '边界右点', x: 4800, ratedLoad: 1000000 });
  const it = await request('POST', '/api/rigItems', {
    name: '边界件',
    weight: 136296,
    cogX: 1,
    leftPointId: a.json.id,
    rightPointId: b.json.id,
    start: 0,
    end: 10,
  });
  assert.strictEqual(it.status, 201);
  const res = await request('GET', '/api/rigging');
  const item = res.json.items.find((x) => x.name === '边界件');
  assert.strictEqual(item.rightShare.num, '5679'); // 136296/4800 约分 = 5679/200 = 28.395
  assert.strictEqual(item.rightShare.den, '200');
  assert.strictEqual(item.rightShare.kg, 28.4, '28.395 精确舍入（半数进位）应为 28.40');
  const right = res.json.points.find((p) => p.id === b.json.id);
  assert.strictEqual(right.peak.kg, 28.4);
});
