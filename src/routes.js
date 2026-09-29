const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const { validate, MODES } = require('./validate');
const { evacuationSnapshot } = require('./evacuation');
const { buildComparison } = require('./baseline');
const { toMarkdown, toReplayMarkdown } = require('./report');
const { findCycle, cycleMessage, MAX_WAIT_SECONDS } = require('./dependencies');
const {
  buildImportPlan,
  commitImport,
  ImportFileError,
  TEMPLATE_HEADER,
} = require('./import');
const { buildReplay, ImportFileError: ReplayFileError } = require('./replay');
const { analyzeSightlines } = require('./sightline');
const { analyzeRigging } = require('./rigging');
const { evaluateCostumeChanges, MAX_CHANGE_SECONDS } = require('./costume');

const router = express.Router();

/** 解析校验模式：缺省为区段独立校验（兼容旧调用），propagate 为连续口令延误传导 */
function parseMode(query) {
  if (query.mode === undefined) return 'classic';
  return MODES.includes(query.mode) ? query.mode : null;
}

/** 取某模式的基线元信息（不携带快照正文） */
function baselineMeta(data, mode) {
  const b = data.baselines && data.baselines[mode];
  return b ? { mode, savedAt: b.savedAt } : null;
}

/** 各模式的基线元信息（用于提示另一模式下是否存在基线） */
function allBaselineMeta(data) {
  const meta = {};
  for (const m of MODES) meta[m] = baselineMeta(data, m);
  return meta;
}

/** 在校验结果上挂载基线信息与基线对比摘要（当前模式存在基线时） */
function withBaseline(result, data, mode) {
  result.baseline = baselineMeta(data, mode);
  result.baselines = allBaselineMeta(data);
  const snapshot = data.baselines && data.baselines[mode];
  result.comparison = snapshot ? buildComparison(result, snapshot.result) : null;
  return result;
}

/**
 * 解析应急疏散快照参数：time（事件时刻，秒）与 exits（出口区域，逗号分隔的 ID 列表）。
 * 两个参数都未提供时返回 { params: null }（不生成快照）；只提供其一或取值非法时返回 { error }。
 */
function parseEvacuation(query, data) {
  const { time, exits } = query;
  if (time === undefined && exits === undefined) return { params: null };
  const t = Number(time);
  if (!Number.isInteger(t) || t < 0) return { error: 'time 必须是不小于 0 的整数秒（事件时刻）' };
  const ids = String(exits || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return { error: 'exits 必须包含至少一个出口区域 ID' };
  const areaIds = new Set(data.areas.map((a) => a.id));
  for (const id of ids) {
    if (!areaIds.has(id)) return { error: `出口区域不存在：${id}` };
  }
  return { params: { time: t, exits: [...new Set(ids)] } };
}

/* ---------- 入参校验 ---------- */

function isNonEmptyString(v, max = 60) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function isNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** 整数厘米坐标 / 尺寸校验（观众视线遮挡检查） */
const CM_COORD_MIN = -1000000;
const CM_COORD_MAX = 1000000;
const CM_HEIGHT_MAX = 100000;

function isCmCoord(v) {
  return Number.isInteger(v) && v >= CM_COORD_MIN && v <= CM_COORD_MAX;
}

function isCmHeight(v) {
  return Number.isInteger(v) && v >= 0 && v <= CM_HEIGHT_MAX;
}

/** 吊挂载荷核算：重量 / 额定载荷（整数千克） */
const RIG_LOAD_MAX = 1000000;

function isRigLoad(v) {
  return Number.isInteger(v) && v >= 1 && v <= RIG_LOAD_MAX;
}

/** 吊点横坐标改为 newX 后，引用它的吊挂件是否仍满足「左 < 右且重心位于两吊点之间」 */
function rigPointRefError(data, pointId, newX) {
  const byId = new Map(data.rigPoints.map((p) => [p.id, p]));
  for (const it of data.rigItems) {
    if (it.leftPointId !== pointId && it.rightPointId !== pointId) continue;
    const left = byId.get(it.leftPointId);
    const right = byId.get(it.rightPointId);
    if (!left || !right) continue;
    const lx = left.id === pointId ? newX : left.x;
    const rx = right.id === pointId ? newX : right.x;
    if (lx >= rx) {
      return `修改后吊挂件「${it.name}」的左吊点横坐标将不再小于右吊点，请先调整该吊挂件`;
    }
    if (it.cogX < lx || it.cogX > rx) {
      return `修改后吊挂件「${it.name}」的重心横坐标将不再位于两吊点之间，请先调整该吊挂件`;
    }
  }
  return null;
}

/** 校验封闭时段数组：[{start, end}]，半开区间 [start, end)，单位秒 */
function validateClosures(closures) {
  if (closures === undefined) return null;
  if (!Array.isArray(closures)) return '封闭时段必须是数组';
  if (closures.length > 50) return '每条连接的封闭时段最多 50 个';
  for (const c of closures) {
    if (!c || !isNonNegativeInt(c.start) || !isNonNegativeInt(c.end)) {
      return '封闭时段的起止必须是不小于 0 的整数秒';
    }
    if (c.start >= c.end) return '封闭时段的开始秒数必须小于结束秒数';
  }
  return null;
}

/** 清洗封闭时段：缺省为空数组，按开始秒数排序 */
function normalizeClosures(closures) {
  if (!Array.isArray(closures)) return [];
  return closures
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((x, y) => x.start - y.start || x.end - y.end);
}

const validators = {
  areas(body) {
    if (!isNonEmptyString(body.name, 30)) return '区域名称必填且不超过 30 字';
    if (body.description !== undefined && typeof body.description !== 'string') return '备注格式不正确';
    return null;
  },
  actors(body) {
    if (!isNonEmptyString(body.name, 30)) return '演员姓名必填且不超过 30 字';
    if (body.role !== undefined && typeof body.role !== 'string') return '角色格式不正确';
    return null;
  },
  edges(body, data) {
    const ids = new Set(data.areas.map((a) => a.id));
    if (!ids.has(body.a) || !ids.has(body.b)) return '连接两端必须是已存在的区域';
    if (body.a === body.b) return '连接两端不能是同一区域';
    if (!isNonNegativeInt(body.seconds)) return '通行耗时必须是不小于 0 的整数秒';
    if (
      body.capacity !== undefined &&
      (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 10)
    ) {
      return '通道容量必须是 1～10 的整数';
    }
    return validateClosures(body.closures);
  },
  cues(body, data) {
    if (!data.actors.some((a) => a.id === body.actorId)) return '必须选择已存在的演员';
    if (!data.areas.some((a) => a.id === body.areaId)) return '必须选择已存在的区域';
    if (!isNonNegativeInt(body.time)) return '时间必须是不小于 0 的整数秒';
    if (body.dwell !== undefined && (!Number.isInteger(body.dwell) || body.dwell < 0 || body.dwell > 600)) {
      return '停留时长必须是 0～600 的整数秒';
    }
    if (body.note !== undefined && typeof body.note !== 'string') return '口令说明格式不正确';
    return null;
  },
  audiencePoints(body) {
    if (!isNonEmptyString(body.name, 30)) return '观众点名称必填且不超过 30 字';
    if (!isCmCoord(body.x) || !isCmCoord(body.y)) {
      return `坐标 x、y 必须是 ${CM_COORD_MIN}～${CM_COORD_MAX} 的整数厘米`;
    }
    if (!isCmHeight(body.eyeHeight)) return `眼高必须是 0～${CM_HEIGHT_MAX} 的整数厘米`;
    return null;
  },
  targets(body) {
    if (!isNonEmptyString(body.name, 30)) return '舞台目标名称必填且不超过 30 字';
    if (!isCmCoord(body.x) || !isCmCoord(body.y)) {
      return `坐标 x、y 必须是 ${CM_COORD_MIN}～${CM_COORD_MAX} 的整数厘米`;
    }
    if (!isCmHeight(body.targetHeight)) return `目标高必须是 0～${CM_HEIGHT_MAX} 的整数厘米`;
    return null;
  },
  obstacles(body) {
    if (!isNonEmptyString(body.name, 30)) return '遮挡物名称必填且不超过 30 字';
    if (!isCmCoord(body.x) || !isCmCoord(body.y)) {
      return `坐标 x、y 必须是 ${CM_COORD_MIN}～${CM_COORD_MAX} 的整数厘米`;
    }
    if (!Number.isInteger(body.width) || body.width < 1 || body.width > CM_COORD_MAX) {
      return '宽必须是 1～1000000 的整数厘米';
    }
    if (!Number.isInteger(body.depth) || body.depth < 1 || body.depth > CM_COORD_MAX) {
      return '深必须是 1～1000000 的整数厘米';
    }
    if (!isCmHeight(body.height)) return `高必须是 0～${CM_HEIGHT_MAX} 的整数厘米`;
    return null;
  },
  rigPoints(body) {
    if (!isNonEmptyString(body.name, 30)) return '吊点名称必填且不超过 30 字';
    if (!isCmCoord(body.x)) return `横坐标必须是 ${CM_COORD_MIN}～${CM_COORD_MAX} 的整数厘米`;
    if (!isRigLoad(body.ratedLoad)) return `额定载荷必须是 1～${RIG_LOAD_MAX} 的整数千克`;
    return null;
  },
  rigItems(body, data) {
    if (!isNonEmptyString(body.name, 30)) return '吊挂件名称必填且不超过 30 字';
    if (!isRigLoad(body.weight)) return `重量必须是 1～${RIG_LOAD_MAX} 的整数千克`;
    if (!isCmCoord(body.cogX)) return `重心横坐标必须是 ${CM_COORD_MIN}～${CM_COORD_MAX} 的整数厘米`;
    const left = data.rigPoints.find((p) => p.id === body.leftPointId);
    const right = data.rigPoints.find((p) => p.id === body.rightPointId);
    if (!left || !right) return '必须选择已存在的左右吊点';
    if (left.id === right.id) return '左右吊点不能是同一个吊点';
    if (left.x >= right.x) return '左吊点的横坐标必须小于右吊点，请检查左右吊点选择';
    if (body.cogX < left.x || body.cogX > right.x) return '重心横坐标必须位于左右吊点之间（含端点）';
    if (!isNonNegativeInt(body.start) || !isNonNegativeInt(body.end)) {
      return '生效起止必须是不小于 0 的整数秒';
    }
    if (body.start >= body.end) return '生效开始秒数必须小于结束秒数';
    return null;
  },
};

function sanitize(collection, body) {
  switch (collection) {
    case 'areas':
      return { name: body.name.trim(), description: (body.description || '').trim() };
    case 'actors':
      return { name: body.name.trim(), role: (body.role || '').trim() };
    case 'edges': {
      const edge = { a: body.a, b: body.b, seconds: body.seconds, closures: normalizeClosures(body.closures) };
      // capacity 缺省时不写入：POST 由路由补默认值 1，PUT 保留原值（兼容旧数据）
      if (body.capacity !== undefined) edge.capacity = body.capacity;
      return edge;
    }
    case 'cues': {
      const cue = { actorId: body.actorId, areaId: body.areaId, time: body.time, note: (body.note || '').trim() };
      // dwell 缺省时不写入：POST 由路由补默认值 0，PUT 保留原值（兼容旧数据）
      if (body.dwell !== undefined) cue.dwell = body.dwell;
      return cue;
    }
    case 'audiencePoints':
      return { name: body.name.trim(), x: body.x, y: body.y, eyeHeight: body.eyeHeight };
    case 'targets':
      return { name: body.name.trim(), x: body.x, y: body.y, targetHeight: body.targetHeight };
    case 'obstacles':
      return { name: body.name.trim(), x: body.x, y: body.y, width: body.width, depth: body.depth, height: body.height };
    case 'rigPoints':
      return { name: body.name.trim(), x: body.x, ratedLoad: body.ratedLoad };
    case 'rigItems':
      return {
        name: body.name.trim(),
        weight: body.weight,
        cogX: body.cogX,
        leftPointId: body.leftPointId,
        rightPointId: body.rightPointId,
        start: body.start,
        end: body.end,
      };
    default:
      return {};
  }
}

/* ---------- 查询 ---------- */

router.get('/data', (req, res) => {
  const data = store.load();
  // 基线快照仅通过 /api/validate 的对比摘要使用，不随基础数据下发
  const { baselines, ...rest } = data;
  res.json(rest);
});

router.get('/validate', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const result = withBaseline(validate(store.load(), mode), store.load(), mode);
  res.json(result);
});

router.get('/report', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  // 可选：携带 time 与 exits 时在报告末尾追加同一份应急疏散快照
  const { params, error } = parseEvacuation(req.query, data);
  if (error) return res.status(400).json({ error });
  const evacuation = params ? evacuationSnapshot(data, mode, params.time, params.exits) : null;
  const md = toMarkdown(withBaseline(validate(data, mode), data, mode), evacuation);
  const filename = encodeURIComponent('舞台走位校验报告.md');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=report.md; filename*=UTF-8''${filename}`);
  res.send(md);
});

/* ---------- 应急疏散快照 ---------- */

router.get('/evacuation', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  const { params, error } = parseEvacuation(req.query, data);
  if (error) return res.status(400).json({ error });
  if (!params) return res.status(400).json({ error: '缺少参数：time（事件时刻）与 exits（出口区域）' });
  res.json(evacuationSnapshot(data, mode, params.time, params.exits));
});

router.post('/reset', (req, res) => {
  store.reset();
  res.json(store.load());
});

/* ---------- 走位方案基线 ---------- */

/** 保存（或覆盖）当前模式的基线快照 */
router.post('/baseline/:mode', (req, res) => {
  const { mode } = req.params;
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  const result = validate(data, mode);
  data.baselines[mode] = { savedAt: new Date().toISOString(), result };
  store.save();
  res.status(201).json({ baseline: baselineMeta(data, mode), comparison: buildComparison(result, data.baselines[mode].result) });
});

/** 清除基线：指定模式；all 清除全部模式 */
router.delete('/baseline/:mode', (req, res) => {
  const { mode } = req.params;
  if (mode !== 'all' && !MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 classic 或 propagate（或 all）' });
  }
  const data = store.load();
  if (mode === 'all') data.baselines = {};
  else delete data.baselines[mode];
  store.save();
  res.status(204).end();
});

/* ---------- 跨演员口令依赖 ---------- */

/** 过滤掉任一端口令已不存在的依赖（删除口令 / 演员 / 区域后保持引用一致） */
function pruneDependencies(data) {
  const cueIds = new Set(data.cues.map((c) => c.id));
  data.dependencies = (data.dependencies || []).filter(
    (d) => cueIds.has(d.predecessorId) && cueIds.has(d.successorId)
  );
}

/** 新增依赖：写入前对整张依赖图做环检测，成环（含自环、重复反向边）不写入 */
router.post('/dependencies', (req, res) => {
  const data = store.load();
  const body = req.body || {};
  const cueIds = new Set(data.cues.map((c) => c.id));
  if (!cueIds.has(body.predecessorId) || !cueIds.has(body.successorId)) {
    return res.status(400).json({ error: '前置 / 后置口令必须是已存在的口令' });
  }
  if (body.predecessorId === body.successorId) {
    return res.status(400).json({ error: '前置与后置不能是同一条口令' });
  }
  if (!isNonNegativeInt(body.waitSeconds) || body.waitSeconds > MAX_WAIT_SECONDS) {
    return res.status(400).json({ error: `至少等待秒数必须是 0～${MAX_WAIT_SECONDS} 的整数` });
  }
  const dup = data.dependencies.some(
    (d) => d.predecessorId === body.predecessorId && d.successorId === body.successorId
  );
  if (dup) return res.status(409).json({ error: '这两条口令之间已存在相同方向的依赖' });

  const candidate = {
    id: crypto.randomUUID(),
    predecessorId: body.predecessorId,
    successorId: body.successorId,
    waitSeconds: body.waitSeconds,
  };
  data.dependencies.push(candidate);

  const cycle = findCycle(data.dependencies);
  if (cycle) {
    data.dependencies.pop(); // 成环：不写入
    return res.status(400).json({ error: cycleMessage(data, cycle), cycle });
  }

  store.save();
  res.status(201).json(candidate);
});

/** 删除依赖 */
router.delete('/dependencies/:id', (req, res) => {
  const data = store.load();
  const idx = data.dependencies.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '依赖不存在' });
  data.dependencies.splice(idx, 1);
  store.save();
  res.status(204).end();
});

/* ---------- 演员换装核查 ---------- */

/** 过滤掉关联口令或换装区域已不存在的换装任务（删除口令 / 演员 / 区域后保持引用一致） */
function pruneCostumeChanges(data) {
  const cueIds = new Set(data.cues.map((c) => c.id));
  const areaIds = new Set(data.areas.map((a) => a.id));
  data.costumeChanges = (data.costumeChanges || []).filter(
    (t) => cueIds.has(t.fromCueId) && cueIds.has(t.toCueId) && areaIds.has(t.areaId)
  );
}

/** 全量换装核查评估：按当前模式取各区段实际出发时刻，两段分别计最早路线（含封闭等待 / 绕行） */
router.get('/costume-changes/evaluate', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  res.json(evaluateCostumeChanges(store.load(), mode));
});

/** 登记换装任务：同一演员相邻两条口令 + 换装区域 + 所需整数秒数；每个区段最多一项 */
router.post('/costume-changes', (req, res) => {
  const data = store.load();
  const body = req.body || {};
  const fromCue = data.cues.find((c) => c.id === body.fromCueId);
  const toCue = data.cues.find((c) => c.id === body.toCueId);
  if (!fromCue || !toCue) return res.status(400).json({ error: '起点 / 终点口令必须是已存在的口令' });
  if (fromCue.id === toCue.id) return res.status(400).json({ error: '起点与终点不能是同一条口令' });
  if (fromCue.actorId !== toCue.actorId) return res.status(400).json({ error: '两条口令必须属于同一位演员' });
  if (!data.areas.some((a) => a.id === body.areaId)) {
    return res.status(400).json({ error: '必须选择已存在的换装区域' });
  }
  if (!isNonNegativeInt(body.seconds) || body.seconds > MAX_CHANGE_SECONDS) {
    return res.status(400).json({ error: `换装所需秒数必须是 0～${MAX_CHANGE_SECONDS} 的整数` });
  }
  // 相邻判定与 simulateActor 同一口径：过滤失效区域后按时间升序，两条口令必须前后相邻
  const areaIds = new Set(data.areas.map((a) => a.id));
  const list = data.cues
    .filter((c) => c.actorId === fromCue.actorId && areaIds.has(c.areaId))
    .slice()
    .sort((x, y) => x.time - y.time);
  const idx = list.findIndex((c) => c.id === fromCue.id);
  if (idx === -1 || idx + 1 >= list.length || list[idx + 1].id !== toCue.id) {
    return res.status(400).json({ error: '两条口令不是该演员按时间排序的相邻口令，无法登记换装任务' });
  }
  const dup = data.costumeChanges.some((t) => t.fromCueId === fromCue.id && t.toCueId === toCue.id);
  if (dup) return res.status(409).json({ error: '该区段已登记换装任务（每个区段最多一项），可先删除原任务' });

  const task = {
    id: crypto.randomUUID(),
    fromCueId: fromCue.id,
    toCueId: toCue.id,
    areaId: body.areaId,
    seconds: body.seconds,
  };
  data.costumeChanges.push(task);
  store.save();
  res.status(201).json(task);
});

/** 删除换装任务 */
router.delete('/costume-changes/:id', (req, res) => {
  const data = store.load();
  const idx = data.costumeChanges.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '换装任务不存在' });
  data.costumeChanges.splice(idx, 1);
  store.save();
  res.status(204).end();
});

/* ---------- 排练数据 CSV 导入 ---------- */

/** CSV 模板下载（带 UTF-8 BOM，Excel 直接打开中文不乱码） */
router.get('/import/template', (req, res) => {
  const lines = [
    TEMPLATE_HEADER.join(','),
    // 两行填写示例：直接上传会按普通数据行参与校验（可能与底库冲突），正式导入前请删除或替换
    ['张三', '饰 王子', '舞台中央', '01:30', '8', '示例行：可直接删除'].join(','),
    ['赵六', '饰 侍卫', '侧台右', '45', '', '新演员将自动创建；停留秒数留空按 0'].join(','),
  ];
  const content = '﻿' + lines.join('\r\n') + '\r\n';
  const filename = encodeURIComponent('排练数据导入模板.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=rehearsal-template.csv; filename*=UTF-8''${filename}`);
  res.send(content);
});

/** 上传预览：解析 CSV，逐行返回问题与带数据版本的导入计划（不写库） */
router.post('/import/preview', (req, res) => {
  const data = store.load();
  const csv = typeof (req.body && req.body.csv) === 'string' ? req.body.csv : '';
  if (csv.trim() === '') return res.status(400).json({ error: '请先选择排练数据 CSV 文件' });
  let plan;
  try {
    plan = buildImportPlan(data, csv);
  } catch (err) {
    if (err instanceof ImportFileError) return res.status(400).json({ error: err.message });
    throw err;
  }
  res.json(plan);
});

/** 提交导入：底库版本变化返回 409 要求重新预览；否则一次性写入全部新演员和口令 */
router.post('/import/commit', (req, res) => {
  const data = store.load();
  const csv = typeof (req.body && req.body.csv) === 'string' ? req.body.csv : '';
  const expectedVersion = req.body && req.body.version;
  if (csv.trim() === '') return res.status(400).json({ error: '提交内容为空，请重新选择 CSV 文件' });
  if (typeof expectedVersion !== 'string') {
    return res.status(400).json({ error: '缺少数据版本，请先重新预览后再提交' });
  }

  let result;
  try {
    result = commitImport(data, csv, expectedVersion);
  } catch (err) {
    if (err instanceof ImportFileError) return res.status(400).json({ error: err.message });
    throw err;
  }

  if (result.status === 'stale') {
    return res.status(409).json({
      error: '底库数据已变化（演员 / 区域 / 口令被修改），请重新预览后再提交',
      currentVersion: result.currentVersion,
    });
  }
  if (result.status === 'invalid') {
    return res.status(400).json({ error: 'CSV 中仍存在错误行，请修正后重新预览', plan: result.plan });
  }
  res.status(201).json({
    createdActors: result.createdActors,
    createdCues: result.createdCues,
    version: result.version,
  });
});

/* ---------- 现场走位复盘 ---------- */

/** 上传现场实际记录 CSV 并返回复盘结果（只读分析，不写库、不改写走位数据） */
router.post('/replay/analyze', (req, res) => {
  const csv = typeof (req.body && req.body.csv) === 'string' ? req.body.csv : '';
  if (csv.trim() === '') return res.status(400).json({ error: '请先选择现场记录 CSV 文件' });
  try {
    res.json(buildReplay(store.load(), csv));
  } catch (err) {
    if (err instanceof ReplayFileError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

/** 下载本次复盘 Markdown：服务端按原始 CSV 重新计算后渲染（结果与页面同口径，不落盘） */
router.post('/replay/report', (req, res) => {
  const csv = typeof (req.body && req.body.csv) === 'string' ? req.body.csv : '';
  if (csv.trim() === '') return res.status(400).json({ error: '复盘内容为空，请重新选择 CSV 文件' });
  let result;
  try {
    result = buildReplay(store.load(), csv);
  } catch (err) {
    if (err instanceof ReplayFileError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const md = toReplayMarkdown(result);
  const filename = encodeURIComponent('现场走位复盘报告.md');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=replay-report.md; filename*=UTF-8''${filename}`);
  res.send(md);
});

/* ---------- 观众视线遮挡检查 ---------- */

/** 全量视线分析：每位观众点 × 每个舞台目标，精确裁剪与各矩形投影的相交参数区间 */
router.get('/sightlines', (req, res) => {
  res.json(analyzeSightlines(store.load()));
});

/* ---------- 吊挂布景载荷核算 ---------- */

/** 全量载荷核算：逐吊挂件力矩平衡分担，逐吊点按半开时段汇总峰值载荷与超额区间 */
router.get('/rigging', (req, res) => {
  res.json(analyzeRigging(store.load()));
});

/* ---------- 通用 CRUD ---------- */

const COLLECTIONS = ['areas', 'edges', 'actors', 'cues', 'audiencePoints', 'targets', 'obstacles', 'rigPoints', 'rigItems'];

router.post('/:collection', (req, res) => {
  const { collection } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const err = validators[collection](req.body || {}, data);
  if (err) return res.status(400).json({ error: err });

  const item = { id: crypto.randomUUID(), ...sanitize(collection, req.body) };
  if (collection === 'cues' && item.dwell === undefined) item.dwell = 0; // 停留时长默认 0
  if (collection === 'edges' && item.capacity === undefined) item.capacity = 1; // 通道容量默认 1

  if (collection === 'edges') {
    const dup = data.edges.some(
      (e) => (e.a === item.a && e.b === item.b) || (e.a === item.b && e.b === item.a)
    );
    if (dup) return res.status(409).json({ error: '两个区域之间已存在连接，可直接编辑耗时' });
  }

  data[collection].push(item);
  store.save();
  res.status(201).json(item);
});

router.put('/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const item = data[collection].find((x) => x.id === id);
  if (!item) return res.status(404).json({ error: '记录不存在' });

  const err = validators[collection](req.body || {}, data);
  if (err) return res.status(400).json({ error: err });

  // 吊点横坐标修改后，引用它的吊挂件仍需满足「左 < 右且重心位于两吊点之间」（先校验再写入）
  if (collection === 'rigPoints') {
    const refErr = rigPointRefError(data, id, req.body.x);
    if (refErr) return res.status(400).json({ error: refErr });
  }

  // 先得到「拟更新后的完整字段」，所有冲突检查都针对它进行；
  // 检查通过前不得改动内存中的现存记录（否则返回 4xx 后内存会留下脏状态，
  // 后续查询 / 校验会读到串改数据，下一次成功保存还可能把脏状态写入数据文件）。
  const updates = sanitize(collection, req.body);

  if (collection === 'edges') {
    // 无向连接：正、反方向视为同一对端点；除自身外与任一条现存连接同对即冲突
    const dup = data.edges.some(
      (e) =>
        e.id !== id &&
        ((e.a === updates.a && e.b === updates.b) || (e.a === updates.b && e.b === updates.a))
    );
    if (dup) {
      return res.status(409).json({ error: '两个区域之间已存在连接' });
    }
  }

  Object.assign(item, updates);
  store.save();
  res.json(item);
});

router.delete('/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const idx = data[collection].findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });

  // 吊点被吊挂件引用时提示并拒绝删除
  if (collection === 'rigPoints') {
    const refs = data.rigItems.filter((it) => it.leftPointId === id || it.rightPointId === id);
    if (refs.length > 0) {
      const names = refs.map((r) => `「${r.name}」`).slice(0, 5).join('、');
      return res.status(409).json({
        error: `无法删除：该吊点被 ${refs.length} 个吊挂件引用（${names}${refs.length > 5 ? ' 等' : ''}），请先删除或修改相关吊挂件`,
      });
    }
  }

  data[collection].splice(idx, 1);

  // 级联清理，保证校验数据一致
  if (collection === 'areas') {
    data.edges = data.edges.filter((e) => e.a !== id && e.b !== id);
    data.cues = data.cues.filter((c) => c.areaId !== id);
  } else if (collection === 'actors') {
    data.cues = data.cues.filter((c) => c.actorId !== id);
  }

  // 删除口令（或因删除区域 / 演员连带删除口令）后，级联清理相关口令依赖
  pruneDependencies(data);
  // 删除口令 / 区域（含连带删除口令）后，级联清理相关换装任务
  pruneCostumeChanges(data);

  store.save();
  res.status(204).end();
});

module.exports = router;
