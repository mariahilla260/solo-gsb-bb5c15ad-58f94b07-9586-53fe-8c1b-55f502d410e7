'use strict';

/*
 * 舞台吊挂布景载荷核算
 *
 * 同一横梁上的吊点：横坐标（整数厘米）+ 额定载荷（整数千克）；
 * 吊挂件：重量（整数千克）、重心横坐标（整数厘米）、左右吊点、生效时段 [起, 止)（整数秒）。
 *
 * 力矩平衡（静力等效）：左吊点横坐标 xL、右吊点横坐标 xR（xL < xR）、重心 g、重量 W：
 *   左吊点分担 = W·(xR − g) / (xR − xL)
 *   右吊点分担 = W·(g − xL) / (xR − xL)
 * 两件分担之和恒等于 W。分担量、逐吊点累计载荷与额定载荷的比较全程使用分数
 * （BigInt 分子 / 分母，自动约分）运算，不做浮点近似：累计载荷恰好等于额定载荷时
 * 不判超额（超额 = 严格大于），避免「1/3 + 1/3 + 1/3」这类临界值因舍入被误判。
 *
 * 时段汇总：吊挂件按半开区间 [起, 止) 生效，同一秒结束先于开始
 * （一件在 t 秒结束、另一件在 t 秒开始，二者在 t 秒不叠加）。逐段扫描得到
 * 各吊点的分段恒定载荷，输出峰值载荷与超额区间（载荷 > 额定载荷）；
 * 首尾相接的连续超额段合并为一条超额区间，并给出区间内的峰值与峰值超额量。
 */

/** 最大公约数（BigInt，非负） */
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

/** 分数 { n, d }（BigInt，d > 0，已约分）：分担量与累计载荷均以分数精确表示 */
function frac(n, d) {
  let bn = BigInt(n);
  let bd = BigInt(d);
  if (bd < 0n) {
    bn = -bn;
    bd = -bd;
  }
  if (bn === 0n) return { n: 0n, d: 1n };
  const g = gcdBig(bn, bd);
  return { n: bn / g, d: bd / g };
}

/** 比较两个分数：a < b 返回 -1，相等返回 0，a > b 返回 1（BigInt 交叉相乘，精确） */
function cmpFrac(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

function addFrac(a, b) {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

function subFrac(a, b) {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}

/**
 * 力矩平衡分担：重量 weight、重心横坐标 cogX，左 / 右吊点横坐标 leftX < rightX。
 * 返回 { left, right }（分数，left + right === weight）。
 */
function momentShare(weight, cogX, leftX, rightX) {
  const span = BigInt(rightX) - BigInt(leftX); // > 0（路由已校验）
  const w = BigInt(weight);
  return {
    left: frac(w * (BigInt(rightX) - BigInt(cogX)), span),
    right: frac(w * (BigInt(cogX) - BigInt(leftX)), span),
  };
}

/** 向下取整除法（b > 0）：BigInt 整除向零取整，负被除数且有余时商需再减 1 */
function floorDivBig(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/**
 * 分数 → 保留 2 位小数的数值：round(n/d × 100) / 100，全程 BigInt 精确舍入
 * （四舍五入、半数进位，与 Math.round 一致：round(x) = floor(x + 1/2)）。
 * 多件分数分担叠加时分子 / 分母可达数百位（如 140 个质数厘米间距的 1/p 相加），
 * 先转浮点会得到 Infinity / Infinity = NaN，故绝不把分子分母转成 Number 再相除；
 * 舍入后的商仅为「载荷 × 100」量级，远在安全整数范围内，转 Number 无精度问题。
 */
function roundFracTo2(f) {
  const q = floorDivBig(200n * f.n + f.d, 2n * f.d);
  return Number(q) / 100;
}

/** 分数转 JSON：num/den 为精确分子分母（字符串，避免大数精度丢失），kg 为分数精确舍入的 2 位小数数值 */
function fracToJson(f) {
  return { num: f.n.toString(), den: f.d.toString(), kg: roundFracTo2(f) };
}

/**
 * 单个吊点的载荷扫描：contribs 为 [{ start, end, share }]（share 为分数）。
 * 半开区间 [start, end)：同一秒结束先于开始；载荷 > 额定载荷为超额，
 * 首尾相接的连续超额段合并为一条区间。
 * 返回 { peak, peakInterval, intervals, rated }（载荷均为分数对象）。
 */
function sweepPoint(ratedLoad, contribs) {
  const rated = frac(ratedLoad, 1);
  const events = new Map(); // t -> { add: [], remove: [] }
  for (const c of contribs) {
    if (!events.has(c.start)) events.set(c.start, { add: [], remove: [] });
    if (!events.has(c.end)) events.set(c.end, { add: [], remove: [] });
    events.get(c.start).add.push(c.share);
    events.get(c.end).remove.push(c.share);
  }
  const times = [...events.keys()].sort((a, b) => a - b);

  let load = frac(0, 1);
  let peak = frac(0, 1);
  let peakInterval = null;
  const intervals = [];
  let cur = null; // 当前（合并中的）超额区间 { start, peakLoad }

  const closeCur = (t) => {
    intervals.push({ start: cur.start, end: t, peakLoad: cur.peakLoad });
    cur = null;
  };

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const ev = events.get(t);
    // 同一秒结束先于开始：先卸载、后加载（半开区间 [起, 止)）
    for (const f of ev.remove) load = subFrac(load, f);
    for (const f of ev.add) load = addFrac(load, f);

    const next = i + 1 < times.length ? times[i + 1] : null;
    if (next === null) {
      // 最后一批事件之后载荷归零（每件吊挂件都有匹配的结束事件），超额区间在此收尾
      if (cur) closeCur(t);
      break;
    }

    // 区间 [t, next) 内载荷恒定
    if (cmpFrac(load, peak) > 0) {
      peak = load;
      peakInterval = { start: t, end: next };
    }
    if (cmpFrac(load, rated) > 0) {
      if (cur) {
        // 相邻连续超额：合并为同一区间，仅更新峰值
        if (cmpFrac(load, cur.peakLoad) > 0) cur.peakLoad = load;
      } else {
        cur = { start: t, peakLoad: load };
      }
    } else if (cur) {
      closeCur(t);
    }
  }

  return { peak, peakInterval, intervals, rated };
}

/**
 * 全量核算：逐吊挂件做力矩平衡分担，逐吊点按半开时段汇总载荷。
 * 返回 { points, items, summary }：
 * - points：按横坐标升序，含峰值载荷、峰值首次出现时段与合并后的超额区间（含超额量）；
 * - items：逐件分担明细（左 / 右吊点各分担多少，分数精确值）；
 * - summary：吊点 / 吊挂件 / 超额吊点 / 超额区间计数。
 */
function analyzeRigging(data) {
  const points = (Array.isArray(data.rigPoints) ? data.rigPoints : [])
    .slice()
    .sort((a, b) => a.x - b.x || String(a.id).localeCompare(String(b.id)));
  const items = Array.isArray(data.rigItems) ? data.rigItems : [];
  const pointById = new Map(points.map((p) => [p.id, p]));

  const contribsByPoint = new Map(points.map((p) => [p.id, []]));
  const itemRows = [];
  for (const item of items) {
    const left = pointById.get(item.leftPointId);
    const right = pointById.get(item.rightPointId);
    // 脏数据兜底（正常数据已被路由校验与 normalize 拦截）：跳过无法核算的吊挂件
    if (!left || !right || left.id === right.id || left.x >= right.x) continue;
    if (item.cogX < left.x || item.cogX > right.x) continue;
    const share = momentShare(item.weight, item.cogX, left.x, right.x);
    contribsByPoint.get(left.id).push({ start: item.start, end: item.end, share: share.left });
    contribsByPoint.get(right.id).push({ start: item.start, end: item.end, share: share.right });
    itemRows.push({
      id: item.id,
      name: item.name,
      weight: item.weight,
      cogX: item.cogX,
      start: item.start,
      end: item.end,
      leftPointId: left.id,
      leftPointName: left.name,
      leftShare: fracToJson(share.left),
      rightPointId: right.id,
      rightPointName: right.name,
      rightShare: fracToJson(share.right),
    });
  }
  itemRows.sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name, 'zh'));

  const pointRows = points.map((p) => {
    const r = sweepPoint(p.ratedLoad, contribsByPoint.get(p.id) || []);
    return {
      id: p.id,
      name: p.name,
      x: p.x,
      ratedLoad: p.ratedLoad,
      peak: fracToJson(r.peak),
      peakInterval: r.peakInterval,
      overloaded: r.intervals.length > 0,
      intervals: r.intervals.map((iv) => ({
        start: iv.start,
        end: iv.end,
        durationSeconds: iv.end - iv.start,
        peakLoad: fracToJson(iv.peakLoad),
        excess: fracToJson(subFrac(iv.peakLoad, r.rated)),
      })),
    };
  });

  return {
    points: pointRows,
    items: itemRows,
    summary: {
      points: pointRows.length,
      items: itemRows.length,
      overloadedPoints: pointRows.filter((p) => p.overloaded).length,
      overloadIntervals: pointRows.reduce((n, p) => n + p.intervals.length, 0),
    },
  };
}

module.exports = { analyzeRigging, momentShare };
