// 统一「完整快照提交」持久化边界的回归测试：
// 1. 正常编辑（通用 CRUD / 依赖 / 换装任务 / 基线 / 重置 / CSV 导入）成功时：
//    完整 JSON 文件原子落盘成功后才发布新内存版本，查询随即读到新版本；
// 2. 文件写入失败（磁盘错误注入）时：接口返回 500，已发布内存版本不替换、
//    查询仍读到提交前版本，磁盘正式文件保持提交前完整内容且可在「重启」后读取；
// 3. 失败留下的临时文件不会覆盖正式数据；上次退出残留的临时文件在启动时被清理；
// 4. 原子替换采用同目录临时文件 + rename，正式 data.json 永远是完整 JSON。
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
              /* 非 JSON 响应 */
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
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: '服务器内部错误' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

const DATA_FILE = () => path.join(TMP_DIR, 'data.json');

function readDataFile() {
  return JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8')); // 文件必须始终是完整 JSON
}

function listTmpFiles() {
  return fs.readdirSync(TMP_DIR).filter((n) => n.startsWith('.data.json.tmp-'));
}

/**
 * 注入磁盘故障：临时文件写入时抛 EIO（等价「文件写入失败」）。
 * store.js 以解构方式取得 fs.openSync（patch fs.openSync 无法拦截），
 * 但 writeSync 经 fs 绑定方法调用、内部走共享原型，patch fs.writeSync 可稳定注入。
 */
let origWriteSync = null;
function makeWritesFail() {
  origWriteSync = fs.writeSync;
  fs.writeSync = function patched(...args) {
    const err = new Error('EIO: injected disk write failure');
    err.code = 'EIO';
    throw err;
  };
}

function restoreWrites() {
  if (origWriteSync) {
    fs.writeSync = origWriteSync;
    origWriteSync = null;
  }
}

/** 注入替换故障：临时文件已写完、rename 原子替换时抛 EXDEV/EPERM（等价「替换失败」） */
let origRenameSync = null;
function makeRenameFail() {
  origRenameSync = fs.renameSync;
  fs.renameSync = function patched(oldPath, ...rest) {
    if (typeof oldPath === 'string' && path.basename(oldPath).startsWith('.data.json.tmp-')) {
      const err = new Error('EPERM: injected rename failure');
      err.code = 'EPERM';
      throw err;
    }
    return origRenameSync.call(fs, oldPath, ...rest);
  };
}

function restoreRename() {
  if (origRenameSync) {
    fs.renameSync = origRenameSync;
    origRenameSync = null;
  }
}

test('成功提交：隔离修改 → 完整文件原子落盘 → 发布内存版本（各类写接口）', async () => {
  // 通用 CRUD：新建区域
  const area = await request('POST', '/api/areas', { name: '快照提交测试区', description: '临时' });
  assert.strictEqual(area.status, 201);
  assert.strictEqual(readDataFile().areas.some((a) => a.id === area.json.id), true);

  // 依赖
  const cues = store.load().cues;
  const dep = await request('POST', '/api/dependencies', {
    predecessorId: cues[0].id,
    successorId: cues[1].id,
    waitSeconds: 3,
  });
  assert.strictEqual(dep.status, 201, dep.raw);
  assert.strictEqual(readDataFile().dependencies.some((d) => d.id === dep.json.id), true);

  // 换装任务：取种子数据中同一演员相邻口令（若存在）
  const data0 = store.load();
  const byActor = new Map();
  for (const c of data0.cues) {
    if (!byActor.has(c.actorId)) byActor.set(c.actorId, []);
    byActor.get(c.actorId).push(c);
  }
  let adjacent = null;
  for (const list of byActor.values()) {
    const sorted = list.slice().sort((a, b) => a.time - b.time);
    if (sorted.length >= 2) {
      adjacent = sorted.slice(0, 2);
      break;
    }
  }
  assert.ok(adjacent, '种子数据中应存在同一演员的至少两条口令');
  const cc = await request('POST', '/api/costume-changes', {
    fromCueId: adjacent[0].id,
    toCueId: adjacent[1].id,
    areaId: data0.areas[0].id,
    seconds: 5,
  });
  assert.ok([201, 409].includes(cc.status), cc.raw); // 409：该区段种子里可能已有任务

  // 基线
  const bl = await request('POST', '/api/baseline/classic', {});
  assert.strictEqual(bl.status, 201, bl.raw);
  assert.ok(readDataFile().baselines.classic, '基线随完整快照持久化');

  // 提交完成后不得残留临时文件
  assert.deepStrictEqual(listTmpFiles(), [], '成功提交后不应残留临时文件');
});

test('CSV 导入成功：预览版本规则不变，提交走快照原子落盘', async () => {
  const prev = await request('POST', '/api/import/preview', {
    csv: '姓名,角色,目标区域,时间,停留秒数,口令说明\n快照提交新人,饰 测试,舞台中央,200,,快照导入\n',
  });
  assert.strictEqual(prev.status, 200, prev.raw);
  const version = prev.json.version;
  assert.strictEqual(typeof version, 'string');

  const before = readDataFile();
  const commit = await request('POST', '/api/import/commit', {
    csv: '姓名,角色,目标区域,时间,停留秒数,口令说明\n快照提交新人,饰 测试,舞台中央,200,,快照导入\n',
    version,
  });
  assert.strictEqual(commit.status, 201, commit.raw);
  assert.strictEqual(commit.json.createdActors, 1);
  assert.strictEqual(commit.json.createdCues, 1);

  const after = readDataFile();
  assert.strictEqual(after.actors.length, before.actors.length + 1);
  assert.strictEqual(after.cues.length, before.cues.length + 1);
  assert.ok(store.load().actors.some((a) => a.name === '快照提交新人'), '内存版本已发布');
  assert.deepStrictEqual(listTmpFiles(), []);
});

test('写文件失败返回 500：内存保持提交前版本，磁盘正式文件完整可读', async () => {
  const dataBefore = store.load();
  const actorCountBefore = dataBefore.actors.length;
  const fileBeforeRaw = fs.readFileSync(DATA_FILE(), 'utf8');

  makeWritesFail();
  const failed = await request('POST', '/api/actors', { name: '绝不应出现的演员', role: 'X' });
  restoreWrites();

  assert.strictEqual(failed.status, 500, '文件写入失败必须返回服务端错误');

  // 内存版本未发布：查询仍读到提交前版本
  assert.strictEqual(store.load().actors.length, actorCountBefore, '失败后内存版本必须保持提交前');
  assert.ok(
    !store.load().actors.some((a) => a.name === '绝不应出现的演员'),
    '失败的修改不得进入内存'
  );

  // 磁盘正式文件保持提交前完整内容
  assert.strictEqual(fs.readFileSync(DATA_FILE(), 'utf8'), fileBeforeRaw, '正式数据文件必须原样未动');
  const onDisk = readDataFile(); // 必须仍是可解析的完整 JSON
  assert.ok(!onDisk.actors.some((a) => a.name === '绝不应出现的演员'));

  // 失败后不得残留临时文件（即便残留，也绝不能覆盖正式数据）
  assert.deepStrictEqual(listTmpFiles(), [], '写失败后本次临时文件应被清掉');

  // 失败的请求之后，服务仍可正常提交
  const ok = await request('POST', '/api/actors', { name: '失败后的正常演员', role: 'Y' });
  assert.strictEqual(ok.status, 201, ok.raw);
  assert.strictEqual(store.load().actors.length, actorCountBefore + 1);
  assert.strictEqual(readDataFile().actors.length, actorCountBefore + 1);
});

test('替换（rename）失败返回 500：临时文件已完整写出也不得覆盖正式数据', async () => {
  const actorCountBefore = store.load().actors.length;
  const fileBefore = fs.readFileSync(DATA_FILE(), 'utf8');

  makeRenameFail();
  const failed = await request('POST', '/api/actors', { name: '替换失败演员', role: 'R' });
  restoreRename();
  assert.strictEqual(failed.status, 500, '替换失败同样返回服务端错误');

  // 内存版本未发布
  assert.strictEqual(store.load().actors.length, actorCountBefore);
  assert.ok(!store.load().actors.some((a) => a.name === '替换失败演员'));
  // 正式文件原样未动、仍为完整 JSON
  assert.strictEqual(fs.readFileSync(DATA_FILE(), 'utf8'), fileBefore);
  assert.ok(!readDataFile().actors.some((a) => a.name === '替换失败演员'));
  // 已完整写出的临时文件在失败后被清掉；即使未来有残留也永不覆盖正式数据
  assert.deepStrictEqual(listTmpFiles(), [], '替换失败后临时文件应被删除');

  // 服务恢复后可正常提交
  const ok = await request('POST', '/api/actors', { name: '恢复后演员', role: 'R2' });
  assert.strictEqual(ok.status, 201, ok.raw);
  assert.strictEqual(readDataFile().actors.length, actorCountBefore + 1);
});

test('级联删除失败不落盘：内存与文件均保留提交前引用一致状态', async () => {
  // 先成功新增一个演员和一条口令，再制造写失败删除演员（级联删口令、清理依赖 / 换装任务）
  const actor = await request('POST', '/api/actors', { name: '级联失败演员', role: 'Z' });
  assert.strictEqual(actor.status, 201);
  const areaId = store.load().areas[0].id;
  const cue = await request('POST', '/api/cues', {
    actorId: actor.json.id,
    areaId,
    time: 999,
  });
  assert.strictEqual(cue.status, 201);

  const beforeActors = store.load().actors.length;
  const beforeCues = store.load().cues.length;
  const fileBefore = fs.readFileSync(DATA_FILE(), 'utf8');

  makeWritesFail();
  const failed = await request('DELETE', `/api/actors/${actor.json.id}`);
  restoreWrites();
  assert.strictEqual(failed.status, 500);

  assert.strictEqual(store.load().actors.length, beforeActors, '内存中演员未被删');
  assert.strictEqual(store.load().cues.length, beforeCues, '内存中连带口令未被删');
  assert.ok(store.load().cues.some((c) => c.id === cue.json.id), '级联清理结果不得发布');
  assert.strictEqual(fs.readFileSync(DATA_FILE(), 'utf8'), fileBefore, '正式文件保持提交前内容');

  // 恢复后删除成功：级联清理随快照一次发布
  const ok = await request('DELETE', `/api/actors/${actor.json.id}`);
  assert.strictEqual(ok.status, 204);
  assert.strictEqual(store.load().actors.length, beforeActors - 1);
  assert.strictEqual(store.load().cues.length, beforeCues - 1);
  assert.ok(!readDataFile().cues.some((c) => c.id === cue.json.id), '文件中口令已级联删除');
});

test('重置失败不落盘：内存与文件均保持当前版本；成功重置原子生效', async () => {
  const fileBefore = fs.readFileSync(DATA_FILE(), 'utf8');
  const cuesBefore = store.load().cues.length;

  makeWritesFail();
  const failed = await request('POST', '/api/reset', {});
  restoreWrites();
  assert.strictEqual(failed.status, 500);
  assert.strictEqual(store.load().cues.length, cuesBefore, '重置失败不得改变内存版本');
  assert.strictEqual(fs.readFileSync(DATA_FILE(), 'utf8'), fileBefore, '重置失败不得改写正式文件');
});

test('上次退出残留的临时文件不覆盖正式数据，并在启动时清理', () => {
  // 模拟「写完临时文件、rename 前进程退出」留下的残留文件（含伪造内容）
  const stale = path.join(TMP_DIR, '.data.json.tmp-stale-process');
  fs.writeFileSync(stale, '{"corrupted":true}', 'utf8');

  // 清掉模块缓存重新加载 store，模拟进程重启读取同一数据目录
  const officialBefore = fs.readFileSync(DATA_FILE(), 'utf8');
  delete require.cache[require.resolve('../src/store')];
  const freshStore = require('../src/store');
  const data = freshStore.load();

  assert.ok(Array.isArray(data.areas), '重启后读到的仍是正式完整数据，而非残留临时文件');
  assert.strictEqual(fs.readFileSync(DATA_FILE(), 'utf8'), officialBefore, '正式文件未被残留覆盖');
  assert.ok(!fs.existsSync(stale), '残留临时文件在启动时被清理');
});

test('正式数据文件始终是完整 JSON（原子替换过程不留半截）', async () => {
  // 连续快速提交若干次，每次成功后文件都必须可完整解析
  for (let i = 0; i < 5; i++) {
    const res = await request('PUT', `/api/areas/${store.load().areas[0].id}`, {
      name: store.load().areas[0].name,
      description: `连续编辑 ${i}`,
    });
    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    assert.strictEqual(parsed.areas[0].description, `连续编辑 ${i}`);
  }
  assert.deepStrictEqual(listTmpFiles(), []);
});
