const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, '..', 'seed', 'sample-data.json');
// 临时文件前缀：data.json.tmp.<pid>.<随机>；仅用于「写完整文件 → rename 替换」，
// 任何替换前退出留下的该前缀文件都是废弃快照，启动时清理，绝不能被读成 / 替换成正式数据。
const TMP_PREFIX = `${path.basename(DATA_FILE)}.tmp.`;

// 当前已发布的内存版本：只有完整 JSON 文件落盘（临时文件写全 + fsync + rename）成功后才会指向新快照。
// 任何写请求都先在它的隔离深拷贝上修改，因此查询永远读到最近一次成功提交的版本。
let cache = null;

/** 数据深拷贝：数据全部为 JSON 可序列化结构，按落盘同口径拷贝即可得到完全隔离的草稿 */
function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

/** 完整快照序列化：与历史文件格式保持一致（两空格缩进、末尾换行） */
function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function fsyncDir(dir) {
  // 落盘目录项，确保 rename 结果在掉电后仍生效；个别平台 / 文件系统不支持目录 fsync 时尽最大努力即可
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* 目录 fsync 不支持时忽略：rename 本身在同一文件系统内仍是原子替换 */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

/**
 * 完整快照原子落盘：
 * 1. 在同目录以「进程号 + 随机数」生成唯一名、O_EXCL 独占新建临时文件——
 *    不会复用、追加或覆盖任何上次运行遗留的临时文件；
 * 2. 把整份 JSON 一次性写入临时文件并 fsync，保证内容完整到达磁盘；
 * 3. rename 原子替换正式数据文件：替换瞬间外部读到的要么是旧文件、要么是新文件，不存在半截文件；
 * 4. fsync 目录，持久化替换结果。
 * 任一步失败：尽力移除本次临时文件后抛错；正式数据文件保持提交前内容不变。
 */
function atomicReplaceFile(content) {
  const tmpFile = path.join(
    DATA_DIR,
    `${TMP_PREFIX}${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  );
  let fd;
  try {
    fd = fs.openSync(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < content.length) {
      offset += fs.writeSync(fd, content, offset, content.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpFile, DATA_FILE);
    fsyncDir(DATA_DIR);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略关闭异常 */
      }
    }
    // 失败清理只删本次新建的临时文件，绝不触碰正式数据文件
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* 临时文件可能已不存在，忽略 */
    }
    throw err;
  }
}

/** 清理上次运行在替换前退出留下的临时文件（它们从未 rename 成功，不是有效数据） */
function cleanupTempFiles() {
  let names;
  try {
    names = fs.readdirSync(DATA_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      fs.unlinkSync(path.join(DATA_DIR, name));
      console.log('[store] 已清理上次运行遗留的临时文件:', name);
    } catch {
      /* 删除失败不影响启动：正式数据文件与其命名空间互不重叠 */
    }
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  cleanupTempFiles();
  if (!fs.existsSync(DATA_FILE)) {
    // 首次初始化同样走「临时文件 → 原子替换」，避免在正式路径上留下半截种子文件
    atomicReplaceFile(fs.readFileSync(SEED_FILE));
    console.log('[store] 数据文件不存在，已用示例数据初始化:', DATA_FILE);
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

function load() {
  if (!cache) {
    ensureDataFile();
    cache = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
  return cache;
}

/**
 * 完整快照提交（所有写接口的唯一入口）：
 * 1. 取当前已发布版本，在隔离深拷贝（草稿）上执行 mutator——修改与级联清理全部落在草稿上，
 *    mutator 抛错（业务校验失败）时既不写文件也不发布新版本，查询继续读到提交前数据；
 * 2. 草稿规整后把完整 JSON 写入临时文件并 fsync，再 rename 原子替换正式文件；
 *    写入 / 替换失败时 mutator 的修改随草稿丢弃，正式文件保持完整，内存版本不变（由路由返回 500）；
 * 3. 仅当替换成功，才把内存版本发布为草稿，并把 mutator 的返回值作为 result 一并交回。
 *
 * @param {(draft: object) => any} mutator 在隔离草稿上完成本次修改（可返回响应所需数据）
 * @returns {{ data: object, result: any }} 发布后的新快照与 mutator 返回值
 */
function commit(mutator) {
  const draft = cloneData(load());
  const result = mutator(draft);
  normalize(draft);
  atomicReplaceFile(Buffer.from(serialize(draft), 'utf8'));
  cache = draft; // 落盘成功之后才发布新内存版本
  return { data: cache, result };
}

/** 恢复示例数据：同样按完整快照提交流程落盘成功后才发布（基线失去对应关系，一并清空） */
function reset() {
  const draft = normalize(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  draft.baselines = {};
  atomicReplaceFile(Buffer.from(serialize(draft), 'utf8'));
  cache = draft;
  return cache;
}

module.exports = { load, commit, reset };
