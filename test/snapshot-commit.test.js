// 完整快照提交（原子持久化）回归测试：
// 1. 成功提交：完整 JSON 写入临时文件并 fsync 后 rename 替换，正式文件即为新快照，内存随即发布；
// 2. mutator 抛错（业务拒绝）：不写文件、不发布新版本，查询仍读到提交前数据；
// 3. 临时文件写入失败：返回 500，内存保持旧版本，正式文件内容不变且仍为合法 JSON，
//    本次临时文件被清理、不会留下可覆盖正式数据的残留；
// 4. rename 失败（模拟「写完整文件后、替换前退出 / 失败」）：返回 500，正式文件保持提交前内容；
//    模拟遗留的临时文件重启时被识别为废弃快照清理，绝不会被读成或替换成正式数据；
// 5. 删除区域的级联清理与删除本身在同一完整快照中提交（依赖 / 换装任务一并落盘）；
// 6. 写接口失败（500）后其他查询与成功写入仍正常，重启后读到的是最近一次成功提交的版本。
//
// 运行：node --test（Node >= 18），使用独立临时 DATA_DIR，不污染仓库内 data/。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-commit-'));
process.env.DATA_DIR = TMP_DIR;

const store = require('../src/store');
const routes = require('../src/routes');
const express = require('express');

const DATA_FILE = path.join(TMP_DIR, 'data.json');
const TMP_PREFIX = 'data.json.tmp.';

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
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function readDataFile() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); // 文件始终必须是完整合法 JSON
}

function listTempFiles() {
  return fs.readdirSync(TMP_DIR).filter((n) => n.startsWith(TMP_PREFIX));
}

function fileText() {
  return fs.readFileSync(DATA_FILE, 'utf8');
}

test('store.commit：草稿修改落盘成功后才发布新版本，临时文件不残留', () => {
  const before = store.load();
  const beforeAreas = before.areas.length;
  const beforeText = fileText();

  const { data, result } = store.commit((draft) => {
    draft.areas.push({ id: 'snap-area-1', name: '快照测试区域', description: '' });
    return { ok: true };
  });

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(data.areas.length, beforeAreas + 1);
  // 已发布内存版本即新快照
  assert.strictEqual(store.load().areas.length, beforeAreas + 1);
  assert.ok(store.load().areas.some((a) => a.id === 'snap-area-1'));
  // 磁盘文件是同一份完整快照
  const onDisk = readDataFile();
  assert.strictEqual(onDisk.areas.length, beforeAreas + 1);
  assert.ok(onDisk.areas.some((a) => a.id === 'snap-area-1'));
  assert.notStrictEqual(fileText(), beforeText);
  // 替换成功后临时文件不得残留
  assert.deepStrictEqual(listTempFiles(), [], '提交成功后不得留下临时文件');
});

test('store.commit：mutator 抛错时不落盘、不发布，草稿外数据不受影响', () => {
  const beforeAreas = store.load().areas.length;
  const beforeText = fileText();

  assert.throws(
    () =>
      store.commit((draft) => {
        draft.areas.push({ id: 'should-never-exist', name: '脏数据', description: '' });
        throw new Error('boom: 业务拒绝');
      }),
    /boom/
  );

  // 内存版本未发布
  assert.strictEqual(store.load().areas.length, beforeAreas);
  assert.ok(!store.load().areas.some((a) => a.id === 'should-never-exist'));
  // 磁盘文件未被触碰
  assert.strictEqual(fileText(), beforeText, '业务拒绝不得改写数据文件');
  assert.deepStrictEqual(listTempFiles(), [], '业务拒绝不得留下临时文件');
});

test('隔离草稿：提交期间对草稿的级联清理不影响当前查询版本', () => {
  const live = store.load();
  const liveCueCount = live.cues.length;
  store.commit((draft) => {
    // 模拟删除某区域时的级联清理：只发生在草稿上
    draft.edges = [];
    draft.cues = [];
    draft.dependencies = [];
    draft.costumeChanges = [];
    // 提交前并发读（同一 JS 线程内同步检查）仍应看到完整的已发布版本
    assert.strictEqual(store.load().cues.length, liveCueCount, '草稿修改期间查询仍读旧版本');
    assert.notStrictEqual(store.load(), draft, '草稿与已发布版本必须是不同对象');
  });
  assert.strictEqual(store.load().cues.length, 0, '提交成功后发布草稿版本');
  // 恢复示例数据，便于后续用例
  store.reset();
  assert.ok(store.load().cues.length > 0);
});

test('写临时文件失败：API 返回 500，内存与正式文件保持提交前版本', async () => {
  const before = readDataFile();
  const beforeActors = store.load().actors.length;
  const origOpen = fs.openSync;
  fs.openSync = function patchedOpen(p, flags, ...rest) {
    if (typeof p === 'string' && path.basename(p).startsWith(TMP_PREFIX)) {
      throw Object.assign(new Error('ENOSPC 模拟：无法创建临时文件'), { code: 'ENOSPC' });
    }
    return origOpen.call(this, p, flags, ...rest);
  };
  try {
    const res = await request('POST', '/api/actors', { name: '不应落盘的演员', role: '' });
    assert.strictEqual(res.status, 500, '写入失败必须返回服务端错误');
  } finally {
    fs.openSync = origOpen;
  }

  // 内存仍是提交前版本
  assert.strictEqual(store.load().actors.length, beforeActors);
  assert.ok(!store.load().actors.some((a) => a.name === '不应落盘的演员'));
  // 正式文件完整且内容不变
  assert.deepStrictEqual(readDataFile(), before, '临时文件创建失败不得改写正式数据文件');
  assert.deepStrictEqual(listTempFiles(), [], '失败时不得留下临时文件');

  // 服务继续可用：成功写入照常提交
  const ok = await request('POST', '/api/actors', { name: '故障恢复后演员', role: '测试' });
  assert.strictEqual(ok.status, 201);
  assert.ok(readDataFile().actors.some((a) => a.id === ok.json.id));
});

test('rename 失败（替换前崩溃）：正式文件保持旧内容，遗留临时文件不覆盖正式数据', async () => {
  const before = readDataFile();
  const beforeActors = store.load().actors.length;
  const origRename = fs.renameSync;
  fs.renameSync = function patchedRename(tmp, target) {
    if (target === DATA_FILE) {
      throw Object.assign(new Error('EIO 模拟：替换失败'), { code: 'EIO' });
    }
    return origRename.call(this, tmp, target);
  };
  let leftoverTmp = null;
  try {
    const res = await request('POST', '/api/actors', { name: '替换失败演员', role: '' });
    assert.strictEqual(res.status, 500, '替换失败必须返回服务端错误');
  } finally {
    fs.renameSync = origRename;
  }

  // 内存未发布
  assert.strictEqual(store.load().actors.length, beforeActors);
  assert.ok(!store.load().actors.some((a) => a.name === '替换失败演员'));
  // 正式文件仍是提交前的完整内容
  assert.deepStrictEqual(readDataFile(), before, 'rename 失败时正式文件必须保持提交前内容');

  // 模拟进程在替换前退出：手工伪造一个「写完整内容但未 rename」的遗留临时文件。
  // 它绝不能被读成正式数据，重启清理后也绝不能覆盖正式文件。
  leftoverTmp = path.join(TMP_DIR, `${TMP_PREFIX}dead-process.${process.pid}.deadbeef`);
  fs.writeFileSync(leftoverTmp, JSON.stringify({ corrupted: '替换前退出的废弃快照', actors: [] }));
  assert.ok(fs.existsSync(leftoverTmp));
  // 正式读取路径完全不参考临时文件
  assert.deepStrictEqual(readDataFile(), before);

  // 重新加载（等价于重启：清缓存 → ensureDataFile 清理遗留临时文件 → 读取正式文件）
  const fresh = rerequireStore();
  const reloaded = fresh.load();
  assert.strictEqual(reloaded.actors.length, beforeActors, '重启后读到的是正式文件，而非废弃临时快照');
  assert.deepStrictEqual(listTempFiles(), [], '重启时必须清理替换前退出留下的临时文件');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), before);
});

test('删除区域：级联清理（连接 / 口令 / 依赖 / 换装任务）在同一完整快照中提交', async () => {
  // 先重置拿到确定的种子状态
  const resetRes = await request('POST', '/api/reset');
  assert.strictEqual(resetRes.status, 200);
  const seed = readDataFile();
  const targetArea = 'area-roof'; // 天台布景：无连接的独立区域；换一个有连接的区域验证级联更充分
  // 选「乐池」：种子中存在相关连接 / 口令时级联生效；这里直接选有口令的区域
  const areaWithCues = seed.areas.find((a) => seed.cues.some((c) => c.areaId === a.id));
  assert.ok(areaWithCues, '种子数据应有带口令的区域');

  const expectedCues = seed.cues.filter((c) => c.areaId !== areaWithCues.id);
  const expectedEdges = seed.edges.filter((e) => e.a !== areaWithCues.id && e.b !== areaWithCues.id);
  const remainingCueIds = new Set(expectedCues.map((c) => c.id));
  const expectedDeps = seed.dependencies.filter(
    (d) => remainingCueIds.has(d.predecessorId) && remainingCueIds.has(d.successorId)
  );
  const remainingAreaIds = new Set(seed.areas.filter((a) => a.id !== areaWithCues.id).map((a) => a.id));
  const expectedCostumes = seed.costumeChanges.filter(
    (t) => remainingCueIds.has(t.fromCueId) && remainingCueIds.has(t.toCueId) && remainingAreaIds.has(t.areaId)
  );

  const res = await request('DELETE', `/api/areas/${areaWithCues.id}`);
  assert.strictEqual(res.status, 204);

  // 磁盘完整快照：删除与全部级联结果一起落盘
  const after = readDataFile();
  assert.ok(!after.areas.some((a) => a.id === areaWithCues.id));
  assert.strictEqual(after.edges.length, expectedEdges.length, '连接级联删除数量一致');
  assert.strictEqual(after.cues.length, expectedCues.length, '口令级联删除数量一致');
  assert.strictEqual(after.dependencies.length, expectedDeps.length, '依赖级联清理数量一致');
  assert.strictEqual(after.costumeChanges.length, expectedCostumes.length, '换装任务级联清理数量一致');
  // 内存版本与磁盘一致（同一次提交发布）
  assert.strictEqual(store.load().cues.length, after.cues.length);
  assert.strictEqual(store.load().dependencies.length, after.dependencies.length);

  // targetArea 变量仅用于说明，不影响断言
  assert.ok(targetArea);
});

test('reset 同样是完整快照提交：落盘内容为种子（基线清空），重启可读', async () => {
  // 先制造一条基线和一条改动
  await request('POST', '/api/baseline/classic');
  await request('POST', '/api/actors', { name: '重置前演员', role: '' });
  assert.ok(Object.keys(readDataFile().baselines || {}).length > 0);

  const res = await request('POST', '/api/reset');
  assert.strictEqual(res.status, 200);

  const onDisk = readDataFile();
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'sample-data.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, { ...seed, baselines: {} });
  assert.ok(!onDisk.actors.some((a) => a.name === '重置前演员'));
  assert.deepStrictEqual(listTempFiles(), []);

  // 重启后仍读到完整种子快照
  const fresh = rerequireStore();
  assert.strictEqual(fresh.load().areas.length, seed.areas.length);
  assert.deepStrictEqual(fresh.load().baselines, {});
});

/** 在干净的模块缓存上重新加载 store（模拟进程重启后的首次 load） */
function rerequireStore() {
  // 删除已缓存的 store 模块，重新 require 得到全新的 cache=null 实例；DATA_DIR 环境变量保持不变
  const storePath = require.resolve('../src/store');
  delete require.cache[storePath];
  return require('../src/store');
}
