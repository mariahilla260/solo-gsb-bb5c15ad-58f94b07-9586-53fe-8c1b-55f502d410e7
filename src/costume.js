// 演员换装核查
// 为同一演员相邻两条到位口令（一个区段）登记换装任务：换装区域 + 所需整数秒数，每个区段最多一项。
// 核查按当前校验模式（区段独立 / 连续口令延误传导）取得该区段的实际出发时刻，
// 依次计算「起点口令区域 → 换装区域」与「换装完成后：换装区域 → 终点口令区域」两段最早路线：
// 两段均复用 graph 的时间依赖 Dijkstra，通道封闭时段造成的等待或绕行自然计入，
// 而不是把静态最短耗时直接相加（第二段的出发时刻 = 第一段实际到达时刻 + 换装秒数）。
// 换装核查仅评估该区段，不回写、也不影响原走位校验结果（与通道占用冲突 / 基线对比无关）。

const { earliestArrival } = require('./graph');
const { simulateActor } = require('./validate');

/** 换装所需秒数上限（整数秒） */
const MAX_CHANGE_SECONDS = 3600;

/** 逐边路线的前端展示结构（与 validate 的 legs 口径一致） */
function routeView(route, fromId, areaName) {
  const nameOf = (id) => areaName.get(id) || id;
  const legs = route.legs.map((l) => ({
    edgeId: l.edgeId,
    fromName: nameOf(l.fromId),
    toName: nameOf(l.toId),
    departTime: l.depart,
    arriveTime: l.arrive,
    waitSeconds: l.wait,
    travelSeconds: l.arrive - l.depart,
  }));
  return {
    path: [fromId, ...route.legs.map((l) => l.toId)].map(nameOf),
    legs,
    waits: legs.filter((l) => l.waitSeconds > 0).map((l) => ({ areaName: l.fromName, seconds: l.waitSeconds })),
  };
}

/**
 * 评估全部换装任务（按当前校验模式）。逐项任务：
 *   - 定位对应区段（同一演员按时间排序的相邻口令），取该模式下该区段的实际出发时刻；
 *   - 段一：起点口令区域 → 换装区域，最早到达即「到达换装区时刻」（封闭等待 / 绕行计入）；
 *   - 换装完成时刻 = 到达换装区时刻 + 所需秒数；
 *   - 段二：自换装完成时刻从换装区域 → 终点口令区域，最早到达即「最终到达时刻」；
 *   - 余量 = 下一口令时刻 − 最终到达时刻（负为缺口）；最终到达 ≤ 下一口令时刻即准时，否则迟到；
 *   - 任一段在连接图上不连通即不可达（封闭时段只会造成等待或绕行，不会造成不可达）。
 * 口令或换装区域已被删除的残留任务、口令不再相邻的任务，标为 unknown（无法评估），不猜测时刻。
 */
function evaluateCostumeChanges(data, mode = 'classic') {
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const actorById = new Map(data.actors.map((a) => [a.id, a]));
  const cueById = new Map(data.cues.map((c) => [c.id, c]));
  const tasks = Array.isArray(data.costumeChanges) ? data.costumeChanges : [];
  const items = [];

  for (const task of tasks) {
    const fromCue = cueById.get(task.fromCueId);
    const toCue = cueById.get(task.toCueId);
    const changeArea = data.areas.find((a) => a.id === task.areaId);
    const actor = fromCue ? actorById.get(fromCue.actorId) : null;

    const item = {
      id: task.id,
      seconds: task.seconds,
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.name : '（已删除演员）',
      changeAreaId: task.areaId,
      changeAreaName: changeArea ? changeArea.name : '（已删除区域）',
      from: fromCue
        ? { cueId: fromCue.id, time: fromCue.time, areaName: areaName.get(fromCue.areaId) || '（已删除区域）', note: fromCue.note || '' }
        : { cueId: task.fromCueId },
      to: toCue
        ? { cueId: toCue.id, time: toCue.time, areaName: areaName.get(toCue.areaId) || '（已删除区域）', note: toCue.note || '' }
        : { cueId: task.toCueId },
      segmentIndex: null, // 对应区段在当前模式推演中的序号（找不到区段时为 null）
      departTime: null, // 区段实际出发时刻（当前模式）
      reachAreaTime: null, // 到达换装区域时刻
      changeDoneTime: null, // 换装完成时刻 = 到达换装区时刻 + 所需秒数
      finalArrivalTime: null, // 最终到达时刻（换装完成后前往终点的最早到达）
      marginSeconds: null, // 相对下一口令的余量（负为缺口）
      status: 'unknown', // ok 准时 / fail 迟到 / unreachable 不可达 / unknown 无法评估
      reason: '',
      leg1: null, // 段一：起点 → 换装区（routeView）
      leg2: null, // 段二：换装区 → 终点（routeView）
    };

    if (!fromCue || !toCue || !changeArea || !actor) {
      item.reason = '关联口令或换装区域已不存在（任务为失效残留，将在下次保存时清理）';
    } else {
      const sim = simulateActor(data, actor, mode);
      const seg = sim.segments.find((s) => s.from.id === fromCue.id && s.to.id === toCue.id);
      if (!seg) {
        item.reason = '两条口令已不再是该演员按时间排序的相邻口令，对应区段不存在';
      } else {
        item.segmentIndex = seg.index;
        item.departTime = seg.depart; // 当前模式下该区段的实际出发时刻（含停留与延误传导）
        // 段一：起点口令区域 → 换装区域（封闭时段造成等待或绕行）
        const leg1 = earliestArrival(data.edges, fromCue.areaId, changeArea.id, seg.depart);
        if (!leg1) {
          item.status = 'unreachable';
          item.reason = '起点口令区域到换装区域在连接图上不连通';
        } else {
          item.reachAreaTime = leg1.time;
          item.changeDoneTime = leg1.time + task.seconds;
          item.leg1 = routeView(leg1, fromCue.areaId, areaName);
          // 段二：换装完成时刻自换装区域出发 → 终点口令区域
          const leg2 = earliestArrival(data.edges, changeArea.id, toCue.areaId, item.changeDoneTime);
          if (!leg2) {
            item.status = 'unreachable';
            item.reason = '换装区域到终点口令区域在连接图上不连通';
          } else {
            item.finalArrivalTime = leg2.time;
            item.marginSeconds = toCue.time - leg2.time;
            item.leg2 = routeView(leg2, changeArea.id, areaName);
            item.status = leg2.time <= toCue.time ? 'ok' : 'fail';
          }
        }
      }
    }
    items.push(item);
  }

  // 稳定排序：演员名 → 起点口令时刻 → 终点口令时刻
  items.sort(
    (x, y) =>
      String(x.actorName).localeCompare(String(y.actorName), 'zh') ||
      (x.from.time ?? 0) - (y.from.time ?? 0) ||
      (x.to.time ?? 0) - (y.to.time ?? 0)
  );

  return {
    mode: mode === 'propagate' ? 'propagate' : 'classic',
    generatedAt: new Date().toISOString(),
    items,
    summary: {
      total: items.length,
      ok: items.filter((i) => i.status === 'ok').length,
      fail: items.filter((i) => i.status === 'fail').length,
      unreachable: items.filter((i) => i.status === 'unreachable').length,
      unknown: items.filter((i) => i.status === 'unknown').length,
    },
  };
}

module.exports = { evaluateCostumeChanges, MAX_CHANGE_SECONDS };
