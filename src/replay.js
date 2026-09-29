/**
 * 现场走位复盘：
 * - 解析 UTF-8 CSV（表头：演员姓名,角色,实际时刻,实际区域），仅解析「现有演员（姓名 + 角色）」与「现有区域（名称）」，
 *   未知 / 歧义值与时间格式问题逐行报错（rows[].issues），错误行不参与对齐；
 * - 服务端按演员将实际记录与计划口令做「保持先后顺序的一对一最优对齐」（序列对齐 DP，每条记录至多匹配一次）：
 *   配对成本 = |实际时刻 − 计划时刻| +（区域不符 300）；漏执行口令 / 多余实际记录各 180；
 *   成本相同时先取配对数多者，再取实际记录行号序列字典序较小者；
 * - 上传分析只读底库，不改写任何走位数据（不调用 store.save）。
 */

const { parseCsv, parseClockSeconds, ImportFileError } = require('./import');

const COL_NAME = '演员姓名';
const COL_ROLE = '角色';
const COL_TIME = '实际时刻';
const COL_AREA = '实际区域';
const REPLAY_HEADER = [COL_NAME, COL_ROLE, COL_TIME, COL_AREA];

const AREA_MISMATCH_PENALTY = 300;
const GAP_PENALTY = 180;

const MAX_NAME_LENGTH = 30;
const MAX_ROLE_LENGTH = 30;

/**
 * 解析复盘 CSV 并完成对齐（不写库）。
 * 结构性问题（空文件 / 缺列 / 非法引号（未加引号字段中出现引号、闭合引号后夹带字符、引号未闭合）/
 * 仅有表头）抛 ImportFileError；
 * 行级问题逐行收集在 rows[].issues，错误行不进入对齐。
 */
function buildReplay(data, csv, generatedAt = new Date().toISOString()) {
  const records = parseCsv(csv);
  if (records.length === 0) throw new ImportFileError('CSV 内容为空，请按「演员姓名,角色,实际时刻,实际区域」格式填写后再上传');

  const header = records[0].map((h) => h.trim());
  const colIndex = {};
  for (const col of REPLAY_HEADER) {
    const at = header.indexOf(col);
    if (at < 0) throw new ImportFileError(`CSV 缺少必需列「${col}」，表头需为：${REPLAY_HEADER.join(',')}`);
    colIndex[col] = at;
  }
  const cell = (record, col) => (record[colIndex[col]] ?? '').trim();

  // 现有演员按「姓名 + 角色」分组（底库可能存在手工制造的同名同角色重名 → 歧义）
  const actorGroups = new Map();
  for (const actor of data.actors) {
    const key = `${actor.name} ${actor.role || ''}`;
    if (!actorGroups.has(key)) actorGroups.set(key, []);
    actorGroups.get(key).push(actor);
  }
  // 现有区域按名称分组
  const areaGroups = new Map();
  for (const area of data.areas) {
    if (!areaGroups.has(area.name)) areaGroups.set(area.name, []);
    areaGroups.get(area.name).push(area);
  }

  const rows = [];
  for (let ri = 1; ri < records.length; ri++) {
    const record = records[ri];
    if (record.every((c) => c.trim() === '')) continue; // 跳过整行空白

    const seq = rows.length + 1;
    const line = ri + 1; // CSV 物理行号（含表头，从 1 起）
    const name = cell(record, COL_NAME);
    const role = cell(record, COL_ROLE);
    const timeRaw = cell(record, COL_TIME);
    const areaName = cell(record, COL_AREA);
    const issues = [];

    /* 演员姓名：必须唯一命中现有演员（姓名 + 角色），未知与歧义均报错 */
    let actorId = null;
    if (!name) {
      issues.push({ code: 'name-required', message: '演员姓名必填' });
    } else if (name.length > MAX_NAME_LENGTH) {
      issues.push({ code: 'name-length', message: `演员姓名不能超过 ${MAX_NAME_LENGTH} 字` });
    } else {
      if (role.length > MAX_ROLE_LENGTH) {
        issues.push({ code: 'role-length', message: `角色不能超过 ${MAX_ROLE_LENGTH} 字` });
      }
      const group = actorGroups.get(`${name} ${role}`) || [];
      if (group.length === 1) {
        actorId = group[0].id;
      } else if (group.length > 1) {
        issues.push({
          code: 'actor-ambiguous',
          message: `演员歧义：底库中存在 ${group.length} 位同名且同角色（${role || '无角色'}）的演员，无法唯一解析`,
        });
      } else {
        issues.push({
          code: 'actor-unknown',
          message: `未知演员：底库中不存在「${name}」（角色：${role || '无角色'}），复盘仅解析现有演员`,
        });
      }
    }

    /* 实际区域：必须唯一命中现有区域名 */
    let areaId = null;
    if (!areaName) {
      issues.push({ code: 'area-required', message: '实际区域必填' });
    } else {
      const group = areaGroups.get(areaName) || [];
      if (group.length === 1) {
        areaId = group[0].id;
      } else if (group.length > 1) {
        issues.push({
          code: 'area-ambiguous',
          message: `区域歧义：底库存在 ${group.length} 个名为「${areaName}」的区域，无法唯一解析`,
        });
      } else {
        issues.push({ code: 'area-unknown', message: `未知区域：「${areaName}」（底库中不存在同名区域）` });
      }
    }

    /* 实际时刻：秒数（90）或 mm:ss（01:30） */
    let time = null;
    if (!timeRaw) {
      issues.push({ code: 'time-required', message: '实际时刻必填' });
    } else {
      time = parseClockSeconds(timeRaw);
      if (time === null) {
        issues.push({
          code: 'time-format',
          message: `实际时刻格式不正确：「${timeRaw}」，需为秒数（如 90）或 mm:ss（如 01:30）`,
        });
      }
    }

    rows.push({
      seq,
      line,
      name,
      role,
      timeRaw,
      time,
      areaName,
      actorId,
      areaId,
      issues,
      valid: issues.length === 0,
    });
  }

  if (rows.length === 0) {
    throw new ImportFileError('CSV 只有表头、没有数据行，请至少填写一条现场实际记录');
  }

  const validRows = rows.filter((r) => r.valid);
  const errorRows = rows.length - validRows.length;

  const areaById = new Map(data.areas.map((a) => [a.id, a]));
  const actorById = new Map(data.actors.map((a) => [a.id, a]));

  // 计划口令按演员分组（排序：计划时刻升序，相同则口令 ID 字典序）
  const cuesByActor = new Map();
  for (const c of data.cues) {
    if (!cuesByActor.has(c.actorId)) cuesByActor.set(c.actorId, []);
    cuesByActor.get(c.actorId).push(c);
  }
  // 实际记录按演员分组（排序：实际时刻升序，相同则 CSV 行号升序；行号唯一故顺序确定）
  const actualByActor = new Map();
  for (const r of validRows) {
    if (!actualByActor.has(r.actorId)) actualByActor.set(r.actorId, []);
    actualByActor.get(r.actorId).push(r);
  }

  const actorIds = new Set([...cuesByActor.keys(), ...actualByActor.keys()]);
  const actors = [...actorIds]
    .map((actorId) => {
      const actor = actorById.get(actorId);
      const cues = (cuesByActor.get(actorId) || [])
        .slice()
        .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
      const actuals = (actualByActor.get(actorId) || [])
        .slice()
        .sort((a, b) => a.time - b.time || a.line - b.line || a.seq - b.seq);
      return alignActor(actor, cues, actuals, areaById);
    })
    // 复盘展示顺序：总成本降序，相同按姓名 / ID，保证结果稳定
    .sort((a, b) => b.cost.total - a.cost.total || a.actorName.localeCompare(b.actorName, 'zh') || a.actorId.localeCompare(b.actorId));

  const sum = (f) => actors.reduce((acc, a) => acc + f(a), 0);
  const summary = {
    totalRows: rows.length,
    validRows: validRows.length,
    errorRows,
    actors: actors.length,
    pairs: sum((a) => a.pairs.length),
    missedCues: sum((a) => a.missed.length),
    extraActuals: sum((a) => a.extra.length),
    areaMismatches: sum((a) => a.cost.areaMismatches),
    totalTimeDiff: sum((a) => a.cost.timeDiff),
    totalCost: sum((a) => a.cost.total),
  };

  return {
    generatedAt,
    header: REPLAY_HEADER,
    rows,
    actors,
    summary,
    costRule: {
      areaMismatchPenalty: AREA_MISMATCH_PENALTY,
      gapPenalty: GAP_PENALTY,
    },
  };
}

/** 配对成本：时差绝对值 + 区域不符 300 */
function pairCost(cue, actual) {
  const timeDiff = Math.abs(actual.time - cue.time);
  const areaMismatch = cue.areaId !== actual.areaId ? 1 : 0;
  return { cost: timeDiff + areaMismatch * AREA_MISMATCH_PENALTY, timeDiff, areaMismatch };
}

/** 比对候选状态：成本升序 → 配对数降序 → 实际记录行号序列字典序升序 */
function betterState(cand, cur) {
  if (cand.cost !== cur.cost) return cand.cost < cur.cost;
  if (cand.pairs !== cur.pairs) return cand.pairs > cur.pairs;
  const a = cand.seqLines;
  const b = cur.seqLines;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/**
 * 单演员序列对齐（Needleman–Wunsch 风格，保持两侧先后顺序，每条记录至多匹配一次）：
 * dp[i][j] 表示前 i 条计划口令与前 j 条实际记录对齐的最优状态；
 * 转移：漏执行口令（+180）/ 多余实际记录（+180）/ 配对（时差 + 区域不符）。
 */
function alignActor(actor, cues, actuals, areaById) {
  const n = cues.length;
  const m = actuals.length;
  const dp = [];
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1);
  }
  dp[0][0] = { cost: 0, pairs: 0, seqLines: [], back: null };

  // 边界：实际记录为空 → 全部口令漏执行
  for (let i = 1; i <= n; i++) {
    dp[i][0] = {
      cost: dp[i - 1][0].cost + GAP_PENALTY,
      pairs: 0,
      seqLines: [],
      back: { pi: i - 1, pj: 0, type: 'miss' },
    };
  }
  // 边界：计划口令为空 → 全部实际记录多余（行号序列只记录参与配对的实际记录）
  for (let j = 1; j <= m; j++) {
    dp[0][j] = {
      cost: dp[0][j - 1].cost + GAP_PENALTY,
      pairs: 0,
      seqLines: [],
      back: { pi: 0, pj: j - 1, type: 'extra' },
    };
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cue = cues[i - 1];
      const actual = actuals[j - 1];

      let best = {
        cost: dp[i - 1][j].cost + GAP_PENALTY, // 第 i 条口令漏执行
        pairs: dp[i - 1][j].pairs,
        seqLines: dp[i - 1][j].seqLines,
        back: { pi: i - 1, pj: j, type: 'miss' },
      };

      const extraPrev = dp[i][j - 1];
      const extraCand = {
        cost: extraPrev.cost + GAP_PENALTY, // 第 j 条实际记录多余（不进入配对行号序列）
        pairs: extraPrev.pairs,
        seqLines: extraPrev.seqLines,
        back: { pi: i, pj: j - 1, type: 'extra' },
      };
      if (betterState(extraCand, best)) best = extraCand;

      const matchPrev = dp[i - 1][j - 1];
      const pc = pairCost(cue, actual);
      const matchCand = {
        cost: matchPrev.cost + pc.cost, // 口令 ↔ 实际记录配对
        pairs: matchPrev.pairs + 1,
        seqLines: [...matchPrev.seqLines, actual.line],
        back: { pi: i - 1, pj: j - 1, type: 'match' },
      };
      if (betterState(matchCand, best)) best = matchCand;

      dp[i][j] = best;
    }
  }

  // 回溯：得到配对、漏执行口令、多余实际记录（配对按计划顺序产出）
  const pairIdxs = [];
  const missedIdxs = new Set();
  const extraIdxs = new Set();
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = dp[i][j].back;
    if (!b) break;
    if (b.type === 'match') {
      pairIdxs.push([i - 1, j - 1]);
    } else if (b.type === 'miss') {
      missedIdxs.add(i - 1);
    } else {
      extraIdxs.add(j - 1);
    }
    i = b.pi;
    j = b.pj;
  }
  pairIdxs.reverse();

  const pairs = pairIdxs.map(([ci, ri]) => {
    const cue = cues[ci];
    const actual = actuals[ri];
    const pc = pairCost(cue, actual);
    const cueArea = areaById.get(cue.areaId);
    const actualArea = areaById.get(actual.areaId);
    return {
      cueId: cue.id,
      cueTime: cue.time,
      cueAreaId: cue.areaId,
      cueAreaName: cueArea ? cueArea.name : '（已删除）',
      cueNote: cue.note || '',
      actualLine: actual.line,
      actualSeq: actual.seq,
      actualTime: actual.time,
      actualAreaId: actual.areaId,
      actualAreaName: actualArea ? actualArea.name : '（已删除）',
      timeDiff: actual.time - cue.time, // 正为晚到、负为早到
      timeDiffAbs: pc.timeDiff,
      areaMatch: pc.areaMismatch === 0,
      cost: pc.cost,
    };
  });

  const missed = [...missedIdxs]
    .sort((a, b) => a - b)
    .map((ci) => {
      const cue = cues[ci];
      const cueArea = areaById.get(cue.areaId);
      return {
        cueId: cue.id,
        cueTime: cue.time,
        cueAreaId: cue.areaId,
        cueAreaName: cueArea ? cueArea.name : '（已删除）',
        cueNote: cue.note || '',
      };
    });

  const extra = [...extraIdxs]
    .sort((a, b) => actuals[a].line - actuals[b].line)
    .map((ri) => {
      const actual = actuals[ri];
      const area = areaById.get(actual.areaId);
      return {
        actualLine: actual.line,
        actualSeq: actual.seq,
        actualTime: actual.time,
        actualAreaId: actual.areaId,
        actualAreaName: area ? area.name : '（已删除）',
      };
    });

  const timeDiffSum = pairs.reduce((acc, p) => acc + p.timeDiffAbs, 0);
  const areaMismatches = pairs.filter((p) => !p.areaMatch).length;
  const total = timeDiffSum + areaMismatches * AREA_MISMATCH_PENALTY + (missed.length + extra.length) * GAP_PENALTY;

  return {
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : '（已删除演员）',
    actorRole: actor ? actor.role || '' : '',
    cueCount: n,
    actualCount: m,
    pairs,
    missed,
    extra,
    matchedLines: dp[n][m].seqLines,
    cost: {
      timeDiff: timeDiffSum,
      areaMismatches,
      areaPenalty: areaMismatches * AREA_MISMATCH_PENALTY,
      missed: missed.length,
      extra: extra.length,
      gapPenalty: (missed.length + extra.length) * GAP_PENALTY,
      total,
    },
  };
}

module.exports = {
  buildReplay,
  REPLAY_HEADER,
  AREA_MISMATCH_PENALTY,
  GAP_PENALTY,
  ImportFileError,
};
