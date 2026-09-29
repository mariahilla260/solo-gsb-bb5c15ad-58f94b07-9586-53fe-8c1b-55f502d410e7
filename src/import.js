const crypto = require('crypto');
const store = require('./store');

/**
 * 排练数据 CSV 导入：
 * - 按「姓名 + 角色」复用现有演员（唯一匹配复用、无匹配新建、多重匹配报错）；
 * - 按区域名精确解析目标区域（未知 / 重名均为错误行）；
 * - 逐行校验时间 / 停留格式，并按解析后的「演员身份 + 目标区域 + 整数秒」
 *   判文件内重复（「90」与「01:30」视为同一时刻）与现有口令冲突；
 * - 预览生成带数据版本（底库 areas/actors/cues 的哈希）的导入计划；
 * - 提交时版本不一致返回 stale（路由层映射为 409），且复用同一判重口径；
 *   存在重复 / 冲突时整批拒绝，否则一次性写入，失败回滚不落库。
 */

const COL_NAME = '姓名';
const COL_ROLE = '角色';
const COL_AREA = '目标区域';
const COL_TIME = '时间';
const COL_DWELL = '停留秒数';
const COL_NOTE = '口令说明';
const REQUIRED_COLUMNS = [COL_NAME, COL_ROLE, COL_AREA, COL_TIME];
const OPTIONAL_COLUMNS = [COL_DWELL, COL_NOTE];
const TEMPLATE_HEADER = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

const MAX_NAME_LENGTH = 30;
const MAX_ROLE_LENGTH = 30;
const MAX_NOTE_LENGTH = 60;
const MAX_DWELL = 600;

// 键分隔符选用不可见控制字符并以转义形式书写：字段内容不可能出现，避免拼接碰撞
const ACTOR_KEY_SEP = '\u0000'; // 演员身份键：姓名 / 角色 分隔
const CUE_KEY_SEP = '\u001f'; // 口令键：身份 / 区域 / 秒 分隔（单元分隔符）

class ImportFileError extends Error {}

/**
 * 严格 RFC 4180 风格 CSV 解析：支持双引号包裹、"" 转义、CRLF/LF、UTF-8 BOM。
 * 按引号位置把字段拆成四种状态，非法引号一律作为文件结构错误抛 ImportFileError：
 *   START  字段起始：尚未消费任何字符，只有此时遇到 " 才能开启引号字段；
 *   BARE   未加引号正文字段（起始后写过普通字符）：此状态下再遇 " 即非法
 *          （如 张"三"丰——引号不会被吞掉、也不会被当成合法内容）；
 *   QUOTED 引号内：逗号 / CR / LF 均为字段内容，连续两个 "" 表示一个字面引号；
 *   CLOSED 闭合引号之后：只允许逗号、行结束（CR/LF）或文件结束，出现任何其它字符
 *          （包括再遇引号）均为非法，杜绝闭合后夹带字符被静默当成字段内容。
 * 引号未成对（文件结束时仍处于 QUOTED）同为结构错误；错误信息带 CSV 物理行号。
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM

  const START = 0; // 字段起始（引号仅允许在此开启）
  const BARE = 1; // 未加引号正文中
  const QUOTED = 2; // 引号内
  const CLOSED = 3; // 闭合引号之后

  const rows = [];
  let row = [];
  let field = '';
  let state = START;
  let line = 1; // CSV 物理行号（从 1 起；引号字段内的换行也计数）
  let quoteStartLine = 0; // 当前引号字段起始行（未闭合报错用）

  const endField = () => {
    row.push(field);
    field = '';
    state = START;
  };
  // 行结束：CRLF 计为一行并额外消费一个字符，CR / LF 同样计一行
  const consumeLineEnd = (i) => (text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1);
  const endRow = (consumed) => {
    endField();
    rows.push(row);
    row = [];
    line += 1;
    return consumed; // 行结束序列消耗的字符数（1 或 2）
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (state === QUOTED) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // 引号内 "" 转义为一个字面引号
          i++;
        } else {
          state = CLOSED;
        }
      } else if (ch === '\r') {
        // 引号字段内的 CRLF / 单个 CR 都是字段内容，整体保留不丢字符
        if (text[i + 1] === '\n') {
          field += '\r\n';
          i++;
        } else {
          field += '\r';
        }
        line++;
      } else {
        if (ch === '\n') line++;
        field += ch; // 引号内逗号、换行及其它字符原样保留
      }
      continue;
    }

    if (state === START || state === BARE) {
      if (ch === '"') {
        if (state === START) {
          state = QUOTED; // 仅字段起始可开启引号
          quoteStartLine = line;
        } else {
          throw new ImportFileError(
            `CSV 第 ${line} 行结构错误：未加引号的字段中不能出现引号（如 张"三"丰）；含引号的字段必须从字段开头用双引号整体包裹，字段内的引号写成两个连续双引号 ""`
          );
        }
      } else if (ch === ',') {
        endField();
      } else if (ch === '\r' || ch === '\n') {
        i += endRow(consumeLineEnd(i)) - 1;
      } else {
        field += ch;
        state = BARE; // 字段以普通字符起始：未加引号，之后引号即非法
      }
      continue;
    }

    // state === CLOSED：闭合引号之后只允许逗号 / 行结束
    if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      i += endRow(consumeLineEnd(i)) - 1;
    } else {
      throw new ImportFileError(
        `CSV 第 ${line} 行结构错误：字段闭合引号之后出现了多余字符「${ch}」；闭合引号后只能紧跟逗号或换行，引号字段中的引号须写成两个连续双引号 ""`
      );
    }
  }

  if (state === QUOTED) {
    throw new ImportFileError(
      `CSV 第 ${quoteStartLine} 行存在未闭合的引号：引号字段必须以成对的双引号结束，请检查引号是否成对出现`
    );
  }
  // 文件以逗号 / 换行结尾时没有待写字段（field === '' 且 row 为空），不补空行；
  // 否则补上最后一个字段与最后一行（含整行空白、空引号字段等合法情形）。
  if (field !== '' || row.length > 0 || state === CLOSED) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 解析 "90"（秒）或 "01:30"（分:秒）形式的时间；非法返回 null */
function parseClockSeconds(str) {
  const s = String(str).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  const m = s.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** 秒 → mm:ss（错误信息展示用） */
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 演员身份键（姓名 + 角色）：用 NUL 作分隔符，避免与字段内容碰撞 */
function actorKey(name, role) {
  return [name, role || ''].join(ACTOR_KEY_SEP);
}

/**
 * 口令判重键：解析后的「演员身份 + 目标区域 + 整数秒」。
 * 演员身份对复用演员用其 ID（id:<actorId>），对新演员用「姓名 + 角色」（new:<键>）；
 * 时间一律使用解析后的整数秒，因此「90」与「01:30」会得到同一个键。
 * 预览与提交必须共用本口径，保证预览数量与实际新增数一致。
 */
function cueDedupKey(actorIdentity, areaId, time) {
  return [actorIdentity, areaId, time].join(CUE_KEY_SEP);
}

/** 底库已有口令的判重键集合（复用演员身份 = 演员 ID） */
function existingCueKeySet(data) {
  return new Set(data.cues.map((c) => cueDedupKey(`id:${c.actorId}`, c.areaId, c.time)));
}

/** 底库数据版本：areas/actors/cues 全量记录的稳定哈希（edges 不参与导入解析，不计入） */
function dataVersion(data) {
  const stable = {
    areas: data.areas
      .map((a) => ({ id: a.id, name: a.name, description: a.description || '' }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    actors: data.actors
      .map((a) => ({ id: a.id, name: a.name, role: a.role || '' }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    cues: data.cues
      .map((c) => ({
        id: c.id,
        actorId: c.actorId,
        areaId: c.areaId,
        time: c.time,
        dwell: Number.isInteger(c.dwell) && c.dwell > 0 ? c.dwell : 0,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

/**
 * 解析 CSV 并生成导入计划（不写库）。
 * 结构性问题（空文件 / 缺列 / 非法引号（未加引号字段中出现引号、闭合引号后夹带字符、引号未闭合）/
 * 仅有表头）抛 ImportFileError；
 * 行级问题逐行收集在 rows[].issues，只要有错误行 validRows 之外的行均禁止提交。
 * 文件内重复按解析后的口令键判定：首个出现的行标记为文件内首次行（非错误），
 * 其后键相同的行标记为重复（错误行）；身份 / 区域 / 时间无法解析的行不混入重复判断。
 */
function buildImportPlan(data, csv) {
  const records = parseCsv(csv);
  if (records.length === 0) throw new ImportFileError('CSV 内容为空，请下载模板填写后再上传');

  const header = records[0].map((h) => h.trim());
  const colIndex = {};
  for (const col of TEMPLATE_HEADER) {
    const at = header.indexOf(col);
    if (at >= 0) colIndex[col] = at;
  }
  for (const col of REQUIRED_COLUMNS) {
    if (!(col in colIndex)) throw new ImportFileError(`CSV 缺少必需列「${col}」，请下载最新模板后按列填写`);
  }
  const cell = (record, col) => (col in colIndex ? (record[colIndex[col]] ?? '') : '').trim();

  // 现有演员按「姓名 + 角色」分组（底库可能存在手工制造的同名同角色重名）
  const actorGroups = new Map();
  for (const actor of data.actors) {
    const key = actorKey(actor.name, actor.role);
    if (!actorGroups.has(key)) actorGroups.set(key, []);
    actorGroups.get(key).push(actor);
  }
  // 现有区域按名称分组
  const areaGroups = new Map();
  for (const area of data.areas) {
    if (!areaGroups.has(area.name)) areaGroups.set(area.name, []);
    areaGroups.get(area.name).push(area);
  }
  // 底库已有口令键：文件内行与现有口令冲突的判断与文件内判重复用同一口径
  const existingKeys = existingCueKeySet(data);

  const rows = [];
  // 文件内口令判重：口令键（演员身份 + 区域 + 解析后整数秒）→ 首次出现的数据行号
  const seenInFile = new Map();
  // 每个口令键出现过的全部数据行号（用于给首次行标注后续重复行）
  const keySeqs = new Map();
  // 行号 → 口令键（仅演员身份 / 区域 / 时间均可解析的行）
  const keyBySeq = new Map();
  const newActorKeys = new Map(); // 新演员键 → { name, role }（按首次出现排序）
  for (let ri = 1; ri < records.length; ri++) {
    const record = records[ri];
    if (record.every((c) => c.trim() === '')) continue; // 跳过整行空白

    const seq = rows.length + 1;
    const name = cell(record, COL_NAME);
    const role = cell(record, COL_ROLE);
    const areaName = cell(record, COL_AREA);
    const timeRaw = cell(record, COL_TIME);
    const dwellRaw = cell(record, COL_DWELL);
    const note = cell(record, COL_NOTE);
    const issues = [];

    /* 姓名 / 角色 */
    let actorStatus = null; // reuse / new / ambiguous
    let actorId = null;
    let actorIdentity = null; // 判重用身份：复用 → id:<演员ID>；新建 → new:<姓名 NUL 角色>
    if (!name) {
      issues.push({ code: 'name-required', message: '姓名必填' });
    } else if (name.length > MAX_NAME_LENGTH) {
      issues.push({ code: 'name-length', message: `姓名不能超过 ${MAX_NAME_LENGTH} 字` });
    } else {
      const group = actorGroups.get(actorKey(name, role)) || [];
      if (group.length === 1) {
        actorStatus = 'reuse';
        actorId = group[0].id;
        actorIdentity = `id:${actorId}`;
      } else if (group.length > 1) {
        actorStatus = 'ambiguous';
        issues.push({
          code: 'actor-ambiguous',
          message: `底库中存在 ${group.length} 位同名且同角色（${role || '无角色'}）的演员，无法按「姓名 + 角色」唯一复用`,
        });
      } else {
        actorStatus = 'new';
        if (role.length > MAX_ROLE_LENGTH) {
          issues.push({ code: 'role-length', message: `角色不能超过 ${MAX_ROLE_LENGTH} 字` });
        } else {
          actorIdentity = `new:${actorKey(name, role)}`;
          const key = actorKey(name, role);
          if (!newActorKeys.has(key)) newActorKeys.set(key, { name, role });
        }
      }
    }
    if (name && role.length > MAX_ROLE_LENGTH && actorStatus !== 'new') {
      issues.push({ code: 'role-length', message: `角色不能超过 ${MAX_ROLE_LENGTH} 字` });
    }

    /* 目标区域 */
    let areaStatus = null; // ok / unknown / ambiguous
    let areaId = null;
    if (!areaName) {
      issues.push({ code: 'area-required', message: '目标区域必填' });
    } else {
      const group = areaGroups.get(areaName) || [];
      if (group.length === 1) {
        areaStatus = 'ok';
        areaId = group[0].id;
      } else if (group.length > 1) {
        areaStatus = 'ambiguous';
        issues.push({
          code: 'area-ambiguous',
          message: `重名区域：底库存在 ${group.length} 个名为「${areaName}」的区域，无法唯一解析`,
        });
      } else {
        areaStatus = 'unknown';
        issues.push({ code: 'area-unknown', message: `未知区域：「${areaName}」（底库中不存在同名区域）` });
      }
    }

    /* 时间 */
    let time = null;
    if (!timeRaw) {
      issues.push({ code: 'time-required', message: '时间必填' });
    } else {
      time = parseClockSeconds(timeRaw);
      if (time === null) {
        issues.push({
          code: 'time-format',
          message: `时间格式不正确：「${timeRaw}」，需为秒数（如 90）或 mm:ss（如 01:30）`,
        });
      }
    }

    /* 停留秒数（留空缺省 0） */
    let dwell = 0;
    if (dwellRaw !== '') {
      const n = Number(dwellRaw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_DWELL) {
        dwell = null;
        issues.push({
          code: 'dwell-format',
          message: `停留秒数格式不正确：「${dwellRaw}」，需为 0～${MAX_DWELL} 的整数（留空缺省 0）`,
        });
      } else {
        dwell = n;
      }
    }

    /* 口令说明 */
    if (note.length > MAX_NOTE_LENGTH) {
      issues.push({ code: 'note-length', message: `口令说明不能超过 ${MAX_NOTE_LENGTH} 字` });
    }

    /*
     * 文件内重复：按解析后的「演员身份 + 目标区域 + 整数秒」构造口令键——
     * 同一演员同一区域的「90」与「01:30」解析后键相同，后出现的行判为重复。
     * 演员身份 / 区域 / 时间任一项无法解析的行不参与判重，保留各自的格式 / 解析错误。
     */
    if (actorIdentity && areaId && time !== null) {
      const dedupKey = cueDedupKey(actorIdentity, areaId, time);
      keyBySeq.set(seq, dedupKey);
      if (!keySeqs.has(dedupKey)) keySeqs.set(dedupKey, []);
      keySeqs.get(dedupKey).push(seq);
      if (seenInFile.has(dedupKey)) {
        issues.push({
          code: 'duplicate',
          message: `文件内重复：与第 ${seenInFile.get(dedupKey)} 数据行为同一演员、同一区域、同一时刻（${fmtClock(time)}）的口令`,
        });
      } else {
        seenInFile.set(dedupKey, seq);
      }

      /* 与现有口令冲突：与文件内判重共用同一口令键口径（仅复用演员可能与底库重） */
      if (actorStatus === 'reuse' && existingKeys.has(dedupKey)) {
        issues.push({
          code: 'conflict',
          message: `与现有口令冲突：${name} ${fmtClock(time)} 到达「${areaName}」的口令已存在`,
        });
      }
    }

    rows.push({
      seq,
      name,
      role,
      areaName,
      timeRaw,
      time,
      dwellRaw,
      dwell,
      note,
      actorStatus,
      actorId,
      areaStatus,
      areaId,
      issues,
      valid: issues.length === 0,
    });
  }

  if (rows.length === 0) {
    throw new ImportFileError('CSV 只有表头、没有数据行，请至少填写一条排练口令');
  }

  // 标注文件内首次行（其口令键在文件内另有后续重复时才标注，非错误）与后续重复行
  for (const row of rows) {
    const key = keyBySeq.get(row.seq);
    if (!key) continue;
    const seqs = keySeqs.get(key);
    if (seqs[0] === row.seq) {
      if (seqs.length > 1) {
        row.firstOccurrence = true;
        row.duplicateSeqs = seqs.slice(1);
      }
    } else {
      row.duplicateOf = seqs[0];
    }
  }

  // 仅当新演员至少有一条可导入行时才真正创建（避免留下没有口令的空演员）
  const validRows = rows.filter((r) => r.valid);
  const newActors = [...newActorKeys.values()].filter((na) =>
    validRows.some((r) => r.actorStatus === 'new' && r.name === na.name && r.role === na.role)
  );

  const countIssue = (code) => rows.filter((r) => r.issues.some((i) => i.code === code)).length;
  const summary = {
    totalRows: rows.length,
    validRows: validRows.length,
    errorRows: rows.length - validRows.length,
    newActors: newActors.length,
    newCues: validRows.length,
    unknownAreas: countIssue('area-unknown'),
    ambiguousAreas: countIssue('area-ambiguous'),
    ambiguousActors: countIssue('actor-ambiguous'),
    formatErrors: rows.filter(
      (r) => r.issues.some((i) => ['time-format', 'dwell-format', 'name-length', 'role-length', 'note-length'].includes(i.code))
    ).length,
    duplicates: countIssue('duplicate'),
    conflicts: countIssue('conflict'),
  };

  return { rows, newActors, summary, version: dataVersion(data) };
}

/**
 * 按预览计划原子提交：
 * 1. 底库版本与预览时不一致 → { status: 'stale' }（HTTP 409），要求重新预览；
 * 2. 重新解析 CSV（不信任客户端回传的计划正文），仍有错误行 → { status: 'invalid' }（HTTP 400）；
 * 3. 写入前按预览的同一口径（演员身份 + 区域 + 解析后整数秒）再复核口令键，
 *    发现文件内重复或与现有口令冲突即抛 ImportFileError 整批拒绝、不写任何数据；
 * 4. 一次性在内存中追加全部新演员与口令并单次落盘；任何异常回滚内存、不部分落库。
 */
function commitImport(data, csv, expectedVersion) {
  const current = dataVersion(data);
  if (current !== expectedVersion) {
    return { status: 'stale', currentVersion: current };
  }

  const plan = buildImportPlan(data, csv); // 结构性错误抛 ImportFileError 由路由处理
  if (plan.summary.errorRows > 0) {
    return { status: 'invalid', plan };
  }

  const actorCount0 = data.actors.length;
  const cueCount0 = data.cues.length;
  try {
    const actorIdByKey = new Map();
    for (const a of data.actors) actorIdByKey.set(actorKey(a.name, a.role), a.id);

    for (const na of plan.newActors) {
      const key = actorKey(na.name, na.role);
      if (actorIdByKey.has(key)) continue; // 防御：底库刚刚出现过同键演员
      const id = crypto.randomUUID();
      data.actors.push({ id, name: na.name, role: na.role });
      actorIdByKey.set(key, id);
    }

    // 与预览同一判重口径：口令键 = 演员身份 + 目标区域 + 解析后整数秒。
    // 预览已按此口径拦下文件内重复与现有口令冲突；此处复核若仍命中重复键，
    // 整批抛错拒绝（由 catch 回滚内存），绝不静默跳过——保证预览数量与实际新增数一致。
    const seenKeys = existingCueKeySet(data);
    for (const row of plan.rows.filter((r) => r.valid)) {
      const actorId = row.actorId || actorIdByKey.get(actorKey(row.name, row.role));
      if (!actorId || !row.areaId || row.time === null) {
        throw new ImportFileError('导入计划与当前底库不一致（演员 / 区域 / 时间无法解析），请重新预览后再提交');
      }
      const key = cueDedupKey(`id:${actorId}`, row.areaId, row.time);
      if (seenKeys.has(key)) {
        throw new ImportFileError(
          `口令文件内重复或与现有口令冲突：${row.name} ${fmtClock(row.time)} 到达「${row.areaName}」，请修正后重新预览`
        );
      }
      seenKeys.add(key);
      data.cues.push({
        id: crypto.randomUUID(),
        actorId,
        areaId: row.areaId,
        time: row.time,
        dwell: row.dwell ?? 0,
        note: row.note || '',
      });
    }

    store.save(); // 单次落盘：成功全部生效，抛异常则回滚内存
    return {
      status: 'ok',
      createdActors: data.actors.length - actorCount0,
      createdCues: data.cues.length - cueCount0,
      version: dataVersion(data),
    };
  } catch (err) {
    // 任何失败：截断回追加前的长度，保证不会部分落库（新演员也一并回滚，不留空演员）
    data.actors.splice(actorCount0);
    data.cues.splice(cueCount0);
    throw err;
  }
}

module.exports = {
  buildImportPlan,
  commitImport,
  dataVersion,
  parseCsv,
  parseClockSeconds,
  cueDedupKey,
  ImportFileError,
  TEMPLATE_HEADER,
};
