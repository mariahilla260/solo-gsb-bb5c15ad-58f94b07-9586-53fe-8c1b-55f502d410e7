'use strict';

/*
 * 观众视线遮挡检查
 *
 * 平面坐标（x, y）与高度（眼高 / 目标高 / 遮挡物高）均为整数厘米；
 * 遮挡物为轴对齐矩形：(x, y) 为最小角，宽沿 x 轴、深沿 y 轴，高为遮挡物顶面高度。
 *
 * 对每条「观众点 → 舞台目标」视线段按参数 t ∈ [0,1]：
 *   平面位置 P(t) = 观众 + t·(目标 − 观众)
 *   视线高度 h(t) = 眼高 + t·(目标高 − 眼高)
 * 与各矩形投影的相交参数区间用 slab 法精确裁剪（分数运算 + BigInt 比较，
 * 只测矩形中心或采样点无法得到的精确区间）：边界接触（区间退化为一点）也算相交。
 * 相交区间内存在 h(t) ≤ 遮挡物高度即被挡（视线高度等于遮挡物高度算被挡）；
 * h 关于 t 线性，故只需检查区间两端点。
 * 首挡物 = 遮挡中的遮挡物里进入参数最小者（并列取退出参数较小、再按 id 保证确定性）。
 * 建议抬高：使视线在全部相交遮挡物（不只当前遮挡中的）的相交区间内严格高于其高度的
 * 最小整数目标高度；若某相交遮挡物的进入参数为 0 且眼高不高于其高度，
 * 则抬高目标无法解决（视线的观众端点已被挡），返回 clearable = false。
 */

/** 分数 { n, d }（BigInt，d > 0）：参数 t 与高度阈值均以分数精确表示 */
function frac(n, d) {
  let bn = BigInt(n);
  let bd = BigInt(d);
  if (bd < 0n) {
    bn = -bn;
    bd = -bd;
  }
  return { n: bn, d: bd };
}

const FRAC_ZERO = frac(0, 1);
const FRAC_ONE = frac(1, 1);

/** 比较两个分数：a < b 返回 -1，相等返回 0，a > b 返回 1（BigInt 交叉相乘，精确） */
function cmpFrac(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

function maxFrac(a, b) {
  return cmpFrac(a, b) >= 0 ? a : b;
}

function minFrac(a, b) {
  return cmpFrac(a, b) <= 0 ? a : b;
}

/** 分数向下取整（BigInt，支持负数） */
function floorFrac(f) {
  if (f.n >= 0n) return f.n / f.d;
  return -((-f.n + f.d - 1n) / f.d);
}

/**
 * 线段 (ax,ay)→(bx,by) 与闭矩形 [x1,x2]×[y1,y2] 的相交参数区间（slab 法精确裁剪）。
 * 边界接触（区间退化为一点）也算相交。
 * 返回 { enter, exit }（[0,1] 内分数，enter ≤ exit）或 null（不相交）。
 */
function clipSegmentRect(ax, ay, bx, by, x1, y1, x2, y2) {
  let enter = FRAC_ZERO;
  let exit = FRAC_ONE;
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0) {
    if (ax < x1 || ax > x2) return null;
  } else {
    const t1 = frac(x1 - ax, dx);
    const t2 = frac(x2 - ax, dx);
    enter = maxFrac(enter, minFrac(t1, t2));
    exit = minFrac(exit, maxFrac(t1, t2));
  }
  if (dy === 0) {
    if (ay < y1 || ay > y2) return null;
  } else {
    const t1 = frac(y1 - ay, dy);
    const t2 = frac(y2 - ay, dy);
    enter = maxFrac(enter, minFrac(t1, t2));
    exit = minFrac(exit, maxFrac(t1, t2));
  }
  if (cmpFrac(enter, exit) > 0) return null;
  return { enter, exit };
}

/**
 * 参数 t（分数）处的视线高度是否 ≤ limit（等于算被挡）。
 * h(t) = 眼高 + t·(目标高 − 眼高)，全部整数厘米，BigInt 精确判定。
 */
function heightAtMost(t, eyeHeight, targetHeight, limit) {
  const lhs =
    t.d * BigInt(eyeHeight) + t.n * (BigInt(targetHeight) - BigInt(eyeHeight));
  return lhs <= t.d * BigInt(limit);
}

/**
 * 单个相交遮挡物对目标高度 H′ 的约束：要求视线在区间 [enter, exit] 内严格高于遮挡物。
 * h 关于 t 线性，等价于两端点处 h 严格大于遮挡物高度：
 *   q·眼高 + p·(H′ − 眼高) > q·遮挡物高   （t = p/q）
 * 返回 { ok: true, minHeight }（满足该遮挡物的最小整数目标高度，BigInt，可能为负）
 * 或 { ok: false }（区间含 t = 0 端点且眼高不高于遮挡物：抬高目标无法解决）。
 */
function obstacleHeightConstraint(clip, eyeHeight, obstacleHeight) {
  let min = null;
  for (const t of [clip.enter, clip.exit]) {
    const p = t.n;
    const q = t.d;
    if (p === 0n) {
      // t = 0 处高度恒为眼高，与目标高度无关
      if (BigInt(eyeHeight) <= BigInt(obstacleHeight)) return { ok: false };
      continue;
    }
    // H′ > (q·(遮挡物高 − 眼高) + p·眼高) / p，取严格大于阈值的最小整数
    const thr = frac(
      q * (BigInt(obstacleHeight) - BigInt(eyeHeight)) + p * BigInt(eyeHeight),
      p
    );
    const need = floorFrac(thr) + 1n;
    if (min === null || need > min) min = need;
  }
  return { ok: true, minHeight: min === null ? 0n : min };
}

/** 分数转 JSON：t 为保留 6 位小数的数值，num/den 为精确分子分母（普通整数，范围安全） */
function fracToJson(f) {
  const num = Number(f.n);
  const den = Number(f.d);
  return { t: Math.round((num / den) * 1e6) / 1e6, num, den };
}

/** 分析一对「观众点 → 舞台目标」 */
function analyzePair(audience, target, obstacles) {
  const eye = audience.eyeHeight;
  const th = target.targetHeight;

  const intersections = [];
  for (const o of obstacles) {
    const clip = clipSegmentRect(
      audience.x,
      audience.y,
      target.x,
      target.y,
      o.x,
      o.y,
      o.x + o.width,
      o.y + o.depth
    );
    if (!clip) continue;
    const blocking =
      heightAtMost(clip.enter, eye, th, o.height) ||
      heightAtMost(clip.exit, eye, th, o.height);
    intersections.push({ obstacle: o, clip, blocking });
  }

  // 按进入参数升序（并列取退出参数、再按 id），首挡物即遮挡物中的第一个
  intersections.sort(
    (u, v) =>
      cmpFrac(u.clip.enter, v.clip.enter) ||
      cmpFrac(u.clip.exit, v.clip.exit) ||
      String(u.obstacle.id).localeCompare(String(v.obstacle.id))
  );

  const first = intersections.find((i) => i.blocking) || null;

  // 使视线严格越过全部相交遮挡物的最小整数目标高度
  let clearable = true;
  let notClearableBy = null;
  let required = null; // BigInt
  for (const it of intersections) {
    const c = obstacleHeightConstraint(it.clip, eye, it.obstacle.height);
    if (!c.ok) {
      clearable = false;
      notClearableBy = it.obstacle;
      break;
    }
    if (required === null || c.minHeight > required) required = c.minHeight;
  }

  let requiredTargetHeight = null;
  let raiseBy = null;
  if (clearable && required !== null) {
    if (required < 0n) required = 0n; // 目标高度不允许为负
    requiredTargetHeight = Number(required);
    raiseBy = Math.max(0, requiredTargetHeight - th);
  } else if (clearable) {
    raiseBy = 0; // 无相交遮挡物
  }

  return {
    audienceId: audience.id,
    audienceName: audience.name,
    eyeHeight: eye,
    targetId: target.id,
    targetName: target.name,
    targetHeight: th,
    status: first ? 'blocked' : 'clear',
    clearable,
    notClearableBy: notClearableBy ? notClearableBy.name : null,
    requiredTargetHeight,
    raiseBy,
    firstObstacle: first
      ? {
          id: first.obstacle.id,
          name: first.obstacle.name,
          height: first.obstacle.height,
          enter: fracToJson(first.clip.enter),
          exit: fracToJson(first.clip.exit),
        }
      : null,
    intersections: intersections.map((it) => ({
      obstacleId: it.obstacle.id,
      obstacleName: it.obstacle.name,
      height: it.obstacle.height,
      blocking: it.blocking,
      enter: fracToJson(it.clip.enter),
      exit: fracToJson(it.clip.exit),
    })),
  };
}

/**
 * 全量分析：每位观众点 × 每个舞台目标一对，按数据顺序遍历（确定性输出）。
 */
function analyzeSightlines(data) {
  const audiences = Array.isArray(data.audiencePoints) ? data.audiencePoints : [];
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const obstacles = Array.isArray(data.obstacles) ? data.obstacles : [];

  const pairs = [];
  for (const a of audiences) {
    for (const t of targets) {
      pairs.push(analyzePair(a, t, obstacles));
    }
  }

  const summary = {
    audiencePoints: audiences.length,
    targets: targets.length,
    obstacles: obstacles.length,
    pairs: pairs.length,
    blocked: pairs.filter((p) => p.status === 'blocked').length,
    clear: pairs.filter((p) => p.status === 'clear').length,
    notClearable: pairs.filter((p) => !p.clearable).length,
  };
  return { pairs, summary };
}

module.exports = { analyzeSightlines, clipSegmentRect };
