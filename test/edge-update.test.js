// 连接（edges）更新提交边界的回归测试：
// 1. 把一条连接的两端改成另一条现存无向连接的端点（正、反方向同一对）→ 409，
//    且该连接的内存状态与磁盘文件都保持原样（耗时/容量/封闭时段同样不得被串改）；
// 2. 409 之后其他资源的成功保存不会把脏状态带入数据文件；
// 3. 合法编辑一次生效，且 /api/validate 按新连接重算。
//
// 运行：node --test（Node >= 18），使用独立临时 DATA_DIR，不污染仓库内 data/。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-put-'));
process.env.DATA_DIR = TMP_DIR;

const store = require('../src/store');
const routes = require('../src/routes');
const express = require('express');

let server;
let base;

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
              /* 204 无响应体 */
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
  base = '';
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function readDataFile() {
  return JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'data.json'), 'utf8'));
}

test('PUT 连接端点撞车（含正反方向）返回 409，内存与文件均保持原样', async () => {
  // edge-wingr-center: 侧台右 <-> 舞台中央；edge-wingl-center: 侧台左 <-> 舞台中央
  const targetId = 'edge-wingr-center';
  const otherId = 'edge-wingl-center';
  const snapshot = JSON.stringify(store.load().edges);
  const fileBefore = readDataFile();

  for (const [a, b] of [
    ['area-wing-l', 'area-center'], // 与现存连接同向
    ['area-center', 'area-wing-l'], // 反方向：无向连接视为同一对
  ]) {
    const body = { a, b, seconds: 99, capacity: 9, closures: [{ start: 1, end: 2 }] };
    const res = await request('PUT', `${base}/api/edges/${targetId}`, body);
    assert.strictEqual(res.status, 409, `端点 ${a}-${b} 应返回 409`);
    assert.ok(/已存在连接/.test(res.json.error), '错误信息保持原有文案');

    // 内存状态：被编辑连接与其余所有连接都不得变化
    assert.strictEqual(JSON.stringify(store.load().edges), snapshot, '409 后内存中的连接列表必须原样');
    const touched = store.load().edges.find((e) => e.id === targetId);
    const untouched = store.load().edges.find((e) => e.id === otherId);
    assert.strictEqual(touched.a, 'area-wing-r');
    assert.strictEqual(touched.b, 'area-center');
    assert.strictEqual(touched.seconds, 4);
    assert.strictEqual(touched.capacity, undefined);
    assert.deepStrictEqual(touched.closures, [{ start: 10, end: 14 }]);
    assert.strictEqual(untouched.seconds, 4);

    // 持久化状态：数据文件不得被写入脏状态
    const fileAfter = readDataFile();
    assert.deepStrictEqual(fileAfter.edges, fileBefore.edges, '409 不得改写数据文件中的连接');
  }
});

test('409 后下一次成功保存不会把脏状态写入数据文件', async () => {
  // 先制造一次被拒绝的端点串改
  const res = await request('PUT', '/api/edges/edge-wingr-center', {
    a: 'area-wing-l',
    b: 'area-center',
    seconds: 99,
    capacity: 9,
    closures: [{ start: 1, end: 2 }],
  });
  assert.strictEqual(res.status, 409);

  // 再成功保存一条无关资源（区域备注），触发 store.save() 全量落盘
  const ok = await request('PUT', '/api/areas/area-wing-r', {
    name: '侧台右',
    description: '回归测试备注',
  });
  assert.strictEqual(ok.status, 200);

  const fileData = readDataFile();
  const edge = fileData.edges.find((e) => e.id === 'edge-wingr-center');
  assert.strictEqual(edge.a, 'area-wing-r');
  assert.strictEqual(edge.b, 'area-center');
  assert.strictEqual(edge.seconds, 4);
  assert.deepStrictEqual(edge.closures, [{ start: 10, end: 14 }]);
});

test('合法编辑一次生效，走位校验按新连接重算', async () => {
  // 侧台右 -> 舞台中央 的合法编辑：只改耗时与容量，不动端点
  const res = await request('PUT', '/api/edges/edge-wingr-center', {
    a: 'area-wing-r',
    b: 'area-center',
    seconds: 7,
    capacity: 3,
    closures: [{ start: 20, end: 25 }],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.seconds, 7);
  assert.strictEqual(res.json.capacity, 3);
  assert.deepStrictEqual(res.json.closures, [{ start: 20, end: 25 }]);

  // 内存与文件都已更新（单次落盘）
  assert.strictEqual(
    store.load().edges.find((e) => e.id === 'edge-wingr-center').seconds,
    7
  );
  assert.strictEqual(
    readDataFile().edges.find((e) => e.id === 'edge-wingr-center').seconds,
    7
  );

  // 走位校验读到新耗时：取一条经过该连接的实际路线，其 leg 行进耗时应为 7
  // （合法编辑时把封闭时段改为 [20,25)，相关区段在 10 秒附近进入不等待，行进恰为 7 秒）
  const v = await request('GET', '/api/validate?mode=classic');
  assert.strictEqual(v.status, 200);
  const allLegs = v.json.actors.flatMap((a) => a.segments.flatMap((s) => s.legs || []));
  const viaEdge = allLegs.filter((l) => l.edgeId === 'edge-wingr-center');
  assert.ok(viaEdge.length > 0, '应有区段经过被编辑的连接');
  for (const leg of viaEdge) {
    assert.strictEqual(leg.travelSeconds, 7, '走位校验必须按新耗时 7 秒重算');
    assert.strictEqual(leg.arriveTime - leg.departTime, 7);
  }
});

test('端点改为自身（保持同一对区域）的合法编辑仍可保存', async () => {
  // 不传容量：保留原值语义；端点不变时即使与「自己」同对也不算重复
  const res = await request('PUT', '/api/edges/edge-wingl-center', {
    a: 'area-center',
    b: 'area-wing-l', // 仅颠倒存储顺序，仍是这两个区域
    seconds: 5,
    closures: [],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.seconds, 5);
});
