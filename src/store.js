const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, '..', 'seed', 'sample-data.json');
// 替换写入用的临时文件前缀（同目录 rename 才能原子替换）；退出残留的同名前缀文件永不覆盖正式数据
const TMP_PREFIX = '.data.json.tmp-';

/** 已发布的内存版本（cache 未加载前为 null）；所有查询只读它，提交成功前绝不替换 */
let cache = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(SEED_FILE, DATA_FILE);
    console.log('[store] 数据文件不存在，已用示例数据初始化:', DATA_FILE);
  }
}

/**
 * 清理上次异常退出（写完临时文件后、rename 前进程退出）留下的临时文件。
 * 只按本进程约定的 TMP_PREFIX 精确匹配；此时正式 data.json 必然不在写入流程中
 * （启动时尚未开始服务请求），清理绝不触碰正式数据。
 */
function cleanupStaleTempFiles() {
  let names = [];
  try {
    names = fs.readdirSync(DATA_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      fs.unlinkSync(path.join(DATA_DIR, name));
      console.log('[store] 已清理上次退出残留的临时文件:', name);
    } catch (err) {
      console.warn('[store] 残留临时文件清理失败（已忽略）:', name, err.message);
    }
  }
}

/** 规整数据结构：补齐缺失的集合与基线存储（兼容旧版数据文件） */
function normalize(data) {
  for (const key of ['areas', 'edges', 'actors', 'cues', 'dependencies', 'costumeChanges', 'audiencePoints', 'targets', 'obstacles', 'rigPoints', 'rigItems']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  // 清理历史残留：依赖任一端口令不存在（如手工编辑过数据文件）时直接丢弃
  const cueIds = new Set(data.cues.map((c) => c.id));
  data.dependencies = data.dependencies.filter(
    (d) => d && cueIds.has(d.predecessorId) && cueIds.has(d.successorId)
  );
  // 清理历史残留：换装任务关联的口令或换装区域不存在时直接丢弃
  const areaIds = new Set(data.areas.map((a) => a.id));
  data.costumeChanges = data.costumeChanges.filter(
    (t) => t && cueIds.has(t.fromCueId) && cueIds.has(t.toCueId) && areaIds.has(t.areaId)
  );
  // 清理历史残留：吊挂件任一吊点不存在时直接丢弃
  const rigPointIds = new Set(data.rigPoints.map((p) => p.id));
  data.rigItems = data.rigItems.filter(
    (it) => it && rigPointIds.has(it.leftPointId) && rigPointIds.has(it.rightPointId)
  );
  // baselines: { [mode]: { savedAt, result } }，基线随数据持久化
  if (!data.baselines || typeof data.baselines !== 'object' || Array.isArray(data.baselines)) {
    data.baselines = {};
  }
  return data;
}

/** 深拷贝完整快照：所有提交都先在隔离副本上修改，已发布版本不受影响 */
function cloneSnapshot(data) {
  return normalize(JSON.parse(JSON.stringify(data)));
}

function loadRaw() {
  return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
}

function load() {
  if (!cache) {
    ensureDataFile();
    cleanupStaleTempFiles();
    cache = loadRaw();
  }
  return cache;
}

/**
 * 原子落盘完整快照：同目录临时文件 → fsync → rename 原子替换 → 目录 fsync。
 * - 写入 / 替换任一环节失败：删除本次临时文件并抛错，正式 data.json 保持原样、可继续读取；
 * - rename 成功后整文件已是新快照；其后的目录 fsync 失败不影响「替换已完成」的事实。
 */
function writeSnapshotAtomic(data) {
  const payload = JSON.stringify(data, null, 2) + '\n';
  const tmpFile = path.join(DATA_DIR, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let fd = null;
  try {
    fd = fs.openSync(tmpFile, 'w', 0o644);
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd); // 临时文件内容先落盘，再做替换
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpFile, DATA_FILE); // 同目录 rename：原子替换，正式文件不会出现半截内容
    // 让目录项变化也落盘（崩溃恢复语义）；个别平台不支持目录 fsync，忽略即可
    let dirFd = null;
    try {
      dirFd = fs.openSync(DATA_DIR, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      /* 平台不支持目录 fsync（如 Windows / 部分容器卷），rename 的原子性不受影响 */
    } finally {
      if (dirFd !== null) fs.closeSync(dirFd);
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关闭失败时交给 unlink 兜底 */
      }
    }
    try {
      fs.unlinkSync(tmpFile); // 本次失败的临时文件不残留（更不会替换正式数据）
    } catch {
      /* 临时文件可能已不存在，忽略 */
    }
    throw err;
  }
}

/**
 * 统一的完整快照提交：
 * 1. 以当前已发布版本为底，构造隔离快照（深拷贝），在其上执行 mutator 的全部修改
 *    （含级联清理）——此阶段抛错只影响副本，已发布内存版本与磁盘文件均不变；
 * 2. 完整 JSON 序列化并以「临时文件 + 原子替换」写入 data.json；
 * 3. 文件替换成功后才把隔离快照发布为新内存版本（后续查询读到新版本）。
 *
 * 文件写入 / 替换失败时向上抛错（由路由返回 500）：不发布新内存版本，
 * 查询仍读到提交前版本，磁盘正式文件保持完整、重启后可读。
 *
 * @param {(draft: object) => any} mutator 在隔离快照上执行修改，返回值随提交结果一并返回
 * @returns {{ data: object, result: any }} 发布后的新快照与 mutator 返回值
 */
function commit(mutator) {
  const current = load();
  const draft = cloneSnapshot(current);
  const result = mutator(draft);
  writeSnapshotAtomic(draft);
  cache = draft; // 落盘成功后才发布新内存版本
  return { data: draft, result };
}

/**
 * 恢复内置示例数据：同样走「隔离快照 → 完整文件原子落盘 → 发布内存版本」。
 * 读取种子文件失败或落盘失败时，现有内存版本与磁盘正式文件均不变。
 */
function reset() {
  const draft = normalize(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  // 恢复示例数据后基线失去对应关系，一并清空
  draft.baselines = {};
  writeSnapshotAtomic(draft);
  cache = draft;
  return cache;
}

module.exports = { load, commit, reset };
