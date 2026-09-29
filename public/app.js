/* 舞台走位校验系统 —— 前端逻辑（原生 JS） */

const MODE_LABEL = {
  propagate: '连续口令延误传导：首条口令准时到位，每段实际出发 = max(计划时刻, 实际到达) + 停留时长；迟到逐段传导，间隔充足时可吸收恢复。',
  classic: '区段独立校验：每段从上一口令计划时刻出发，段与段互不影响（停留时长不参与本模式）。',
};

const MODE_NAME = { propagate: '连续口令延误传导', classic: '区段独立校验' };

const state = {
  data: { areas: [], edges: [], actors: [], cues: [], dependencies: [], costumeChanges: [], audiencePoints: [], targets: [], obstacles: [], rigPoints: [], rigItems: [] },
  validation: null,
  mode: localStorage.getItem('validate-mode') === 'classic' ? 'classic' : 'propagate',
  evacuation: null, // 已生成快照的参数 { time, exits: [areaId] }；null 表示未启用
  evacResult: null, // 最近一次应急疏散快照结果
  importCsv: null, // 最近一次选择的 CSV 原文
  importPlan: null, // 服务端返回的导入计划（含 rows / newActors / summary / version）
  importFileName: '',
  replayCsv: null, // 最近一次复盘 CSV 原文
  replayResult: null, // 服务端返回的复盘结果
  replayFileName: '',
  sightlines: null, // 观众视线遮挡检查结果（pairs / summary）
  sightFocus: null, // 当前高亮的视线对键 `${audienceId}|${targetId}`
  rigging: null, // 吊挂布景载荷核算结果（points / items / summary）
  costumeEval: null, // 演员换装核查评估结果（items / summary，按当前模式）
  requestSeq: 0, // 全量刷新与模式刷新共用的最新请求标识：每次发起自增，过期请求结果不得更新页面
};

/* ---------- 工具 ---------- */

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(sec) {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 解析 "90" 或 "01:30" 形式的时间输入，返回秒数；非法返回 NaN */
function parseTime(str) {
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return NaN;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `请求失败（${res.status}）`);
    e.status = res.status;
    e.payload = err;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

function areaName(id) {
  const a = state.data.areas.find((x) => x.id === id);
  return a ? a.name : '（已删除）';
}

function actorName(id) {
  const a = state.data.actors.find((x) => x.id === id);
  return a ? a.name : '（已删除）';
}

/* ---------- 数据加载与渲染 ---------- */

/**
 * 全量刷新：数据 / 校验 / 换装 / 视线 / 吊挂一次拉齐。
 * 与模式刷新共用 state.requestSeq（最新请求标识），按发起时的模式成组拉取校验与换装结果；
 * 仅当该组仍是最新请求、且返回的模式与当前模式一致时才落库与重绘。
 * 刷新被更新的请求取代（或模式已变化）时返回 false，调用方不应再据此提示或更新其他界面。
 */
async function refresh() {
  const seq = ++state.requestSeq;
  const mode = state.mode;
  const [data, validation, sightlines, rigging, costumeEval] = await Promise.all([
    api('/api/data'),
    api(`/api/validate?mode=${mode}`),
    api('/api/sightlines'),
    api('/api/rigging'),
    api(`/api/costume-changes/evaluate?mode=${mode}`),
  ]);

  // 旧请求（含 A→B→A 中首次 A 的请求）晚于新请求返回时整体丢弃，不更新页面
  if (seq !== state.requestSeq) return false;
  if (validation.mode !== state.mode || costumeEval.mode !== state.mode) return false;

  state.data = data;
  state.validation = validation;
  state.sightlines = sightlines;
  state.rigging = rigging;
  state.costumeEval = costumeEval;
  renderAreas();
  renderEdges();
  renderActors();
  renderCues();
  renderDependencies();
  renderValidation();
  renderEvacExitOptions();
  renderCostumeChanges();
  renderAudiencePoints();
  renderTargets();
  renderObstacles();
  renderSightlines();
  renderRigPoints();
  renderRigItems();
  renderRigging();
  await refreshEvacuation({ seq, mode });
  // 疏散请求返回后再校验一次（其结果也可能晚于更新的请求）
  return seq === state.requestSeq && state.mode === mode;
}

/**
 * 仅重新校验并刷新结果区（模式切换 / 重新校验 / 基线变更时使用）。
 * 与全量刷新共用同一自增标识；校验、换装与疏散快照按发起时模式成组提交，
 * 只有「对应当前模式且属于最新请求」的结果才会更新页面。
 * A→B→A 时首次 A 的 seq 已失效，其结果不会覆盖末次 A。返回是否被采纳。
 */
async function refreshValidation() {
  const seq = ++state.requestSeq;
  const mode = state.mode;
  const [validation, costumeEval] = await Promise.all([
    api(`/api/validate?mode=${mode}`),
    api(`/api/costume-changes/evaluate?mode=${mode}`),
  ]);

  if (seq !== state.requestSeq) return false;
  if (validation.mode !== state.mode || costumeEval.mode !== state.mode) return false;

  state.validation = validation;
  state.costumeEval = costumeEval;
  renderValidation();
  renderDependencies();
  renderCostumeChanges();
  // 疏散快照按发起时模式成组还原位置；守卫同 seq 与模式，过期结果不更新页面
  await refreshEvacuation({ seq, mode });
  return seq === state.requestSeq && state.mode === mode;
}

/** 更新「导出校验报告」链接：已生成疏散快照时携带同一快照参数，报告将追加同一快照 */
function updateExportHref() {
  let href = `/api/report?mode=${state.mode}`;
  if (state.evacuation) {
    href += `&time=${state.evacuation.time}&exits=${state.evacuation.exits.map(encodeURIComponent).join(',')}`;
  }
  $('btn-export').href = href;
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('validate-mode', mode);
  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('mode-hint').textContent = MODE_LABEL[mode];
  updateExportHref();
}

function renderAreas() {
  const tbody = $('areas-tbody');
  tbody.innerHTML = state.data.areas
    .map(
      (a) => `<tr>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.description || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-area="${a.id}">编辑</button>
          <button class="btn btn-danger" data-del-area="${a.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="3" class="empty-hint">暂无区域</td></tr>';
}

function renderEdges() {
  const tbody = $('edges-tbody');
  tbody.innerHTML = state.data.edges
    .map((e) => {
      const closures = Array.isArray(e.closures) ? e.closures : [];
      const closuresText = closures.length
        ? closures.map((c) => `${c.start}~${c.end} 秒`).join('、')
        : '<span class="empty-hint">无</span>';
      const capacity = Number.isInteger(e.capacity) && e.capacity >= 1 ? e.capacity : 1;
      return `<tr>
        <td>${escapeHtml(areaName(e.a))}</td>
        <td>${escapeHtml(areaName(e.b))}</td>
        <td>${e.seconds} 秒</td>
        <td>${capacity} 人</td>
        <td class="closures-cell">${closuresText}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-edge="${e.id}">编辑</button>
          <button class="btn btn-danger" data-del-edge="${e.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="6" class="empty-hint">暂无连接</td></tr>';
}

function renderActors() {
  const tbody = $('actors-tbody');
  tbody.innerHTML = state.data.actors
    .map(
      (a) => `<tr>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.role || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-actor="${a.id}">编辑</button>
          <button class="btn btn-danger" data-del-actor="${a.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="3" class="empty-hint">暂无演员</td></tr>';
}

function renderCues() {
  const tbody = $('cues-tbody');
  const sorted = state.data.cues
    .slice()
    .sort((x, y) => actorName(x.actorId).localeCompare(actorName(y.actorId), 'zh') || x.time - y.time);
  tbody.innerHTML = sorted
    .map(
      (c) => `<tr>
        <td>${escapeHtml(actorName(c.actorId))}</td>
        <td>${fmtTime(c.time)}</td>
        <td>${escapeHtml(areaName(c.areaId))}</td>
        <td>${c.dwell > 0 ? `${c.dwell} 秒` : '<span class="empty-hint">—</span>'}</td>
        <td>${escapeHtml(c.note || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-cue="${c.id}">编辑</button>
          <button class="btn btn-danger" data-del-cue="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="6" class="empty-hint">暂无口令</td></tr>';
}

const STATUS_LABEL = { ok: '✅ 可达', fail: '❌ 超时', unreachable: '⛔ 不可达' };

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="badge"><span class="num">${s.actors}</span><span class="label">演员</span></div>
    <div class="badge"><span class="num">${s.segments}</span><span class="label">校验区段</span></div>
    <div class="badge ok"><span class="num">${s.ok}</span><span class="label">按时可达</span></div>
    <div class="badge fail"><span class="num">${s.failed}</span><span class="label">无法按时抵达</span></div>
    <div class="badge warn"><span class="num">${s.unreachable}</span><span class="label">区域不可达</span></div>
    <div class="badge conflict"><span class="num">${s.conflicts || 0}</span><span class="label">通道占用冲突</span></div>
    <div class="badge dep"><span class="num">${s.dependencies || 0}</span><span class="label">口令依赖 满足${s.dependenciesSatisfied || 0}/违约${s.dependenciesViolated || 0}/未知${s.dependenciesUnknown || 0}</span></div>
  `;
}

/** 通道占用冲突总览（全局，跨演员） */
function renderConflicts(conflicts) {
  const el = $('conflict-overview');
  if (!conflicts || conflicts.length === 0) {
    el.innerHTML = '<p class="empty-hint">✅ 所有连接各时刻并发占用均未超过容量，无通道占用冲突（首尾相接不算重叠，等待不占用通道）。</p>';
    return;
  }
  const rows = conflicts
    .map((c, idx) => {
      const occs = c.occupancies
        .map(
          (o) =>
            `<li><strong>${escapeHtml(o.actorName)}</strong> ${escapeHtml(o.direction)}：` +
            `${fmtTime(o.enter)} 进入 ~ ${fmtTime(o.leave)} 离开（${escapeHtml(o.actorName)} 区段 ${o.segmentIndex}）</li>`
        )
        .join('');
      return `<div class="conflict-card">
        <div class="conflict-head">
          <span class="conflict-no">冲突 ${idx + 1}</span>
          <span class="conflict-edge">🚶 ${escapeHtml(c.edgeName)}</span>
          <span class="conflict-time">${fmtTime(c.startTime)} ~ ${fmtTime(c.endTime)}（${c.durationSeconds} 秒）</span>
          <span class="conflict-peak">容量 ${c.capacity} / 峰值 ${c.peak} 人</span>
        </div>
        <ul class="conflict-occs">${occs}</ul>
      </div>`;
    })
    .join('');
  el.innerHTML = `<p class="conflict-intro">共发现 <strong>${conflicts.length}</strong> 段连续超载区间（已合并首尾相接的连续超载）：</p>${rows}`;
}

/* ---------- 走位方案基线对比 ---------- */

function fmtSavedAt(iso) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 区段行内的状态文本（基线对比用） */
function cmpStatusText(status) {
  return STATUS_LABEL[status] || status;
}

function cmpArrivalText(entry, side) {
  const t = side === 'base' ? entry.baseArrivalTime : entry.currentArrivalTime;
  return t === null || t === undefined ? '—' : fmtTime(t);
}

function cmpLatenessText(l) {
  if (l === null || l === undefined) return '—';
  return l > 0 ? `${l} 秒` : '准时';
}

function cmpRouteText(pathArr) {
  return Array.isArray(pathArr) && pathArr.length > 0 ? pathArr.map(escapeHtml).join(' → ') : '—';
}

/** 新增 / 移除区段小条目 */
function renderCmpEntry(e, kind) {
  const late = e.lateness > 0 ? `迟到 ${e.lateness} 秒` : '准时';
  return `<li class="cmp-seg ${kind}">
    <span class="cmp-seg-actor">${escapeHtml(e.actorName)}</span>
    <span class="cmp-seg-route">${escapeHtml(e.fromArea)}（${fmtTime(e.fromTime)}）→ ${escapeHtml(e.toArea)}（${fmtTime(e.toTime)}）</span>
    <span class="status-pill ${e.status}">${cmpStatusText(e.status)}</span>
    <span class="cmp-seg-meta">实际到达 ${e.arrivalTime === null || e.arrivalTime === undefined ? '—' : fmtTime(e.arrivalTime)} · ${e.lateness === null ? '—' : late}</span>
  </li>`;
}

/** 共有区段变化明细行 */
function renderCmpSharedRow(e) {
  const segTitle = `${escapeHtml(e.fromArea)}（${fmtTime(e.fromTime)}）→ ${escapeHtml(e.toArea)}（${fmtTime(e.toTime)}）`;

  let statusCell = `<span class="cmp-from">${cmpStatusText(e.baseStatus)}</span> → <span class="status-pill ${e.currentStatus}">${cmpStatusText(e.currentStatus)}</span>`;
  if (e.statusDirection === 'improved') statusCell += ' <span class="cmp-dir up">⬆ 转好</span>';
  else if (e.statusDirection === 'worsened') statusCell += ' <span class="cmp-dir down">⬇ 转差</span>';

  let arrivalCell = `<span class="cmp-from">${cmpArrivalText(e, 'base')}</span> → <strong>${cmpArrivalText(e, 'cur')}</strong>`;
  if (e.arrivalChanged) {
    arrivalCell += e.arrivalDelta < 0
      ? ` <span class="cmp-delta up">早 ${-e.arrivalDelta} 秒</span>`
      : ` <span class="cmp-delta down">晚 ${e.arrivalDelta} 秒</span>`;
  }

  let lateCell = `<span class="cmp-from">${cmpLatenessText(e.baseLateness)}</span> → <strong>${cmpLatenessText(e.currentLateness)}</strong>`;
  if (e.latenessChanged) {
    lateCell += e.latenessDelta < 0
      ? ` <span class="cmp-delta up">减少 ${-e.latenessDelta} 秒</span>`
      : ` <span class="cmp-delta down">增加 ${e.latenessDelta} 秒</span>`;
  }

  let routeCell = '<span class="empty-hint">无变化</span>';
  if (e.routeChanged) {
    routeCell = `<div class="cmp-route"><span class="cmp-from">${cmpRouteText(e.basePath)}</span> → <strong>${cmpRouteText(e.currentPath)}</strong></div>`;
  }

  const confBits = [];
  for (const c of e.conflictsAdded) {
    confBits.push(`<span class="conflict-tag cmp-conf new">🆕 ${escapeHtml(c.edgeName)} ${fmtTime(c.startTime)}~${fmtTime(c.endTime)}（峰值 ${c.peak}/${c.capacity}）</span>`);
  }
  for (const c of e.conflictsResolved) {
    confBits.push(`<span class="conflict-tag cmp-conf gone">✅ 解除 ${escapeHtml(c.edgeName)} ${fmtTime(c.startTime)}~${fmtTime(c.endTime)}</span>`);
  }
  const conflictCell = confBits.length ? `<span class="conflict-tags">${confBits.join('')}</span>` : '<span class="empty-hint">—</span>';

  return `<tr>
    <td>${escapeHtml(e.actorName)}</td>
    <td>${e.index} · ${segTitle}</td>
    <td>${statusCell}</td>
    <td>${arrivalCell}</td>
    <td>${lateCell}</td>
    <td class="route">${routeCell}</td>
    <td>${conflictCell}</td>
  </tr>`;
}

/** 基线对比面板：保存 / 覆盖 / 清除入口，以及即时对比摘要 */
function renderBaseline(v) {
  const panel = $('baseline-panel');
  const currentMode = v.mode;
  const meta = v.baselines || {};
  const cur = meta[currentMode];
  const otherMode = currentMode === 'propagate' ? 'classic' : 'propagate';
  const other = meta[otherMode];

  // 另一模式存在基线、当前模式没有：模式不一致，当前不比较，仅提示
  let mismatch = '';
  if (!cur && other) {
    mismatch = `<p class="baseline-mismatch">⚠️ 已在「${MODE_NAME[otherMode]}」模式保存过基线（${fmtSavedAt(other.savedAt)}），` +
      `与当前「${MODE_NAME[currentMode]}」模式不一致，不对其比较；` +
      `<button type="button" class="btn-link" data-baseline-clear="${otherMode}">清除该模式基线</button>，或切换回该模式查看对比。</p>`;
  }

  if (!cur) {
    panel.innerHTML = `
      <div class="baseline-bar">
        <span class="baseline-title">📸 走位方案基线</span>
        <span class="baseline-info">当前「${MODE_NAME[currentMode]}」模式尚无基线，保存后编辑区域、连接、演员或口令时将在此即时对比。</span>
        <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">保存当前结果为基线</button>
      </div>${mismatch}`;
    return;
  }

  const cmp = v.comparison;
  if (!cmp) {
    panel.innerHTML = `<div class="baseline-bar">
      <span class="baseline-title">📸 走位方案基线</span>
      <span class="baseline-info">基线保存于 ${fmtSavedAt(cur.savedAt)}</span>
      <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">覆盖基线</button>
      <button type="button" class="btn btn-danger btn-small" data-baseline-clear="${currentMode}">清除基线</button>
    </div>${mismatch}`;
    return;
  }

  const s = cmp.summary;
  const chips = [
    `<span class="cmp-chip add">新增区段 <strong>${s.segmentsAdded}</strong></span>`,
    `<span class="cmp-chip del">移除区段 <strong>${s.segmentsRemoved}</strong></span>`,
    `<span class="cmp-chip">共有 <strong>${s.segmentsShared}</strong></span>`,
    `<span class="cmp-chip ${s.statusImproved ? 'good' : ''}">状态转好 <strong>${s.statusImproved}</strong></span>`,
    `<span class="cmp-chip ${s.statusWorsened ? 'bad' : ''}">状态转差 <strong>${s.statusWorsened}</strong></span>`,
    `<span class="cmp-chip ${s.latenessImproved ? 'good' : ''}">迟到减少 <strong>${s.latenessImproved}</strong></span>`,
    `<span class="cmp-chip ${s.latenessWorsened ? 'bad' : ''}">迟到增加 <strong>${s.latenessWorsened}</strong></span>`,
    `<span class="cmp-chip ${s.conflictsAdded ? 'bad' : ''}">冲突新增 <strong>${s.conflictsAdded}</strong></span>`,
    `<span class="cmp-chip ${s.conflictsResolved ? 'good' : ''}">冲突解除 <strong>${s.conflictsResolved}</strong></span>`,
  ].join('');

  const noDiff =
    s.segmentsAdded === 0 &&
    s.segmentsRemoved === 0 &&
    s.segmentsChanged === 0;

  let body = '';
  if (noDiff) {
    body = '<p class="cmp-identical">✅ 当前结果与基线完全一致（区段键：演员 ID + 相邻口令 ID，按稳定键匹配，不按数组位置对齐）。</p>';
  } else {
    body += '<p class="cmp-keyhint">区段按「演员 ID + 相邻口令 ID」稳定匹配，不按数组位置对齐。</p>';
    if (cmp.added.length) {
      body += `<div class="cmp-group"><h4>🟢 新增区段（${cmp.added.length}）</h4><ul class="cmp-seg-list">${cmp.added.map((e) => renderCmpEntry(e, 'added')).join('')}</ul></div>`;
    }
    if (cmp.removed.length) {
      body += `<div class="cmp-group"><h4>🔴 移除区段（${cmp.removed.length}）</h4><ul class="cmp-seg-list">${cmp.removed.map((e) => renderCmpEntry(e, 'removed')).join('')}</ul></div>`;
    }
    if (cmp.shared.length) {
      const rows = cmp.shared.map(renderCmpSharedRow).join('');
      body += `<div class="cmp-group">
        <h4>🟡 共有区段变化（${cmp.shared.length}）</h4>
        <table class="cmp-table">
          <thead><tr><th>演员</th><th>区段（起点 → 终点）</th><th>状态（基线 → 当前）</th><th>实际到达</th><th>迟到秒数</th><th>路线</th><th>关联通道冲突</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    } else if (s.segmentsShared > 0) {
      body += `<p class="empty-hint">共有 ${s.segmentsShared} 个区段均无变化。</p>`;
    }
  }

  panel.innerHTML = `
    <div class="baseline-bar">
      <span class="baseline-title">📸 走位方案基线</span>
      <span class="baseline-info">基线保存于 ${fmtSavedAt(cur.savedAt)}（${MODE_NAME[currentMode]}）· 报告将追加同样的对比摘要</span>
      <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">覆盖基线</button>
      <button type="button" class="btn btn-danger btn-small" data-baseline-clear="${currentMode}">清除基线</button>
    </div>
    ${mismatch}
    <div class="cmp-chips">${chips}</div>
    <div class="cmp-detail">${body}</div>`;
}

function renderValidation() {
  const v = state.validation;
  if (!v) return;
  renderBaseline(v);
  renderSummary(v.summary);
  renderConflicts(v.conflicts);

  const container = $('validation-results');
  if (v.actors.length === 0) {
    container.innerHTML = '<p class="empty-hint">暂无演员，请先添加演员与到位口令。</p>';
    return;
  }

  const propagate = v.mode === 'propagate';
  container.innerHTML = v.actors
    .map((actor) => {
      if (actor.segments.length === 0) {
        return `<div class="actor-block">
          <h3>${escapeHtml(actor.actorName)} <span class="cue-count">（${actor.cueCount} 条口令，不足两条，无需校验）</span></h3>
        </div>`;
      }
      const rows = actor.segments.map((seg) => (propagate ? renderPropagateRow(seg) : renderClassicRow(seg))).join('');
      const chainTag = propagate
        ? actor.finalLateness > 0
          ? `<span class="chain-tag late">末条口令最终迟到 ${actor.finalLateness} 秒</span>`
          : '<span class="chain-tag absorbed">末条口令准时（延误已全部吸收）</span>'
        : '';
      const head = propagate
        ? '<thead><tr><th>#</th><th>起点</th><th>终点</th><th>出发（计划 / 实际）</th><th>实际到达</th><th>继承延误</th><th>最终迟到</th><th>实际路线（含等待）</th><th>结论</th></tr></thead>'
        : '<thead><tr><th>#</th><th>起点</th><th>终点</th><th>耗时校验</th><th>实际路线（含等待）</th><th>结论</th></tr></thead>';
      return `<div class="actor-block">
        <h3>${escapeHtml(actor.actorName)} <span class="cue-count">（${actor.cueCount} 条口令 / ${actor.segments.length} 个区段）</span> ${chainTag}</h3>
        <table>${head}<tbody>${rows}</tbody></table>
      </div>`;
    })
    .join('');
}

/** 区段关联的通道冲突标签（两种模式共用） */
function renderConflictTags(seg) {
  if (!seg.conflicts || seg.conflicts.length === 0) return '';
  const tags = seg.conflicts
    .map(
      (c) =>
        `<span class="conflict-tag" title="容量 ${c.capacity} 人，峰值 ${c.peak} 人">🚶 ${escapeHtml(c.edgeName)} ` +
        `${fmtTime(c.startTime)}~${fmtTime(c.endTime)}（峰值 ${c.peak}/${c.capacity} 人）</span>`
    )
    .join('');
  return `<span class="conflict-tags">${tags}</span>`;
}

/** 区段独立校验模式的结果行 */
function renderClassicRow(seg) {
  let timeCell;
  if (seg.status === 'unreachable') {
    timeCell = `<span class="time-detail">可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail"><strong>两区域间无连通路径</strong></span>`;
  } else if (seg.status === 'fail') {
    timeCell = `<span class="time-detail">所需 <strong>${seg.requiredSeconds} 秒</strong> / 可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail"><strong>缺口 ${-seg.slackSeconds} 秒</strong></span>
                <span class="time-detail">最早到达 ${fmtTime(seg.arrivalTime)}</span>`;
  } else {
    timeCell = `<span class="time-detail">所需 ${seg.requiredSeconds} 秒 / 可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail">余量 ${seg.slackSeconds} 秒</span>
                <span class="time-detail">最早到达 ${fmtTime(seg.arrivalTime)}</span>`;
  }
  return `<tr class="seg-${seg.status}${seg.conflicts && seg.conflicts.length ? ' has-conflict' : ''}">
    <td>${seg.index}</td>
    <td>${escapeHtml(seg.from.areaName)}<span class="time-detail">${fmtTime(seg.from.time)}${seg.from.note ? ' · ' + escapeHtml(seg.from.note) : ''}</span></td>
    <td>${escapeHtml(seg.to.areaName)}<span class="time-detail">${fmtTime(seg.to.time)}${seg.to.note ? ' · ' + escapeHtml(seg.to.note) : ''}</span></td>
    <td>${timeCell}</td>
    <td class="route">${renderRouteCell(seg)}${renderConflictTags(seg)}</td>
    <td><span class="status-pill ${seg.status}">${STATUS_LABEL[seg.status]}</span></td>
  </tr>`;
}

/** 连续口令延误传导模式的结果行：计划/实际出发、实际到达、继承延误、最终迟到 */
function renderPropagateRow(seg) {
  const fromDwell = seg.from.dwell > 0 ? ` · 停留 ${seg.from.dwell} 秒` : '';
  const toDwell = seg.to.dwell > 0 ? ` · 停留 ${seg.to.dwell} 秒` : '';
  const departLate = seg.actualDepart - seg.plannedDepart;
  const departCell =
    departLate > 0
      ? `<span class="time-detail">计划 ${fmtTime(seg.plannedDepart)}</span>
         <span class="time-detail"><strong>实际 ${fmtTime(seg.actualDepart)}（晚 ${departLate} 秒）</strong></span>`
      : `<span class="time-detail">计划 ${fmtTime(seg.plannedDepart)}</span>
         <span class="time-detail">实际 ${fmtTime(seg.actualDepart)}</span>`;
  const arrivalCell =
    seg.status === 'unreachable'
      ? '<span class="time-detail"><strong>两区域间无连通路径</strong></span>'
      : `${fmtTime(seg.arrivalTime)}<span class="time-detail">计划 ${fmtTime(seg.to.time)}</span>`;
  const inheritedCell =
    seg.inheritedDelay > 0
      ? `<span class="delay-tag">+${seg.inheritedDelay} 秒</span>`
      : '<span class="empty-hint">—</span>';
  const lateCell =
    seg.lateness === null
      ? '<span class="empty-hint">—</span>'
      : seg.lateness > 0
        ? `<span class="late-tag">迟到 ${seg.lateness} 秒</span>`
        : '<span class="ontime-tag">准时</span>';
  return `<tr class="seg-${seg.status}${seg.conflicts && seg.conflicts.length ? ' has-conflict' : ''}">
    <td>${seg.index}</td>
    <td>${escapeHtml(seg.from.areaName)}<span class="time-detail">${fmtTime(seg.from.time)}${fromDwell}${seg.from.note ? ' · ' + escapeHtml(seg.from.note) : ''}</span></td>
    <td>${escapeHtml(seg.to.areaName)}<span class="time-detail">${fmtTime(seg.to.time)}${toDwell}${seg.to.note ? ' · ' + escapeHtml(seg.to.note) : ''}</span></td>
    <td>${departCell}</td>
    <td>${arrivalCell}</td>
    <td>${inheritedCell}</td>
    <td>${lateCell}</td>
    <td class="route">${renderRouteCell(seg)}${renderConflictTags(seg)}</td>
    <td><span class="status-pill ${seg.status}">${STATUS_LABEL[seg.status]}</span></td>
  </tr>`;
}

/** 路线单元格：路径链 + 逐边时刻与等待标注（两种模式共用） */
function renderRouteCell(seg) {
  const route = seg.path.length > 0 ? escapeHtml(seg.path.join(' → ')) : '—';
  let legDetail = '';
  if (seg.legs && seg.legs.length > 0) {
    const parts = seg.legs.map((l) => {
      let s = `${fmtTime(l.departTime)} ${escapeHtml(l.fromName)} → ${fmtTime(l.arriveTime)} ${escapeHtml(l.toName)}`;
      if (l.waitSeconds > 0) {
        s += ` <span class="wait-tag">⏱ 在 ${escapeHtml(l.fromName)} 等待 ${l.waitSeconds} 秒</span>`;
      }
      return s;
    });
    legDetail = `<span class="leg-detail">${parts.join('<br>')}</span>`;
  }
  return route + legDetail;
}

/* ---------- 应急疏散快照 ---------- */

/** 出口区域勾选框：快照启用时以快照参数为准，否则保留当前勾选 */
function renderEvacExitOptions() {
  const el = $('evac-exits');
  const checkedNow = new Set([...el.querySelectorAll('input:checked')].map((i) => i.value));
  const selected = state.evacuation ? new Set(state.evacuation.exits) : checkedNow;
  el.innerHTML =
    state.data.areas
      .map((a) => {
        const checked = selected.has(a.id) ? ' checked' : '';
        return `<label class="evac-exit"><input type="checkbox" value="${a.id}"${checked} /> ${escapeHtml(a.name)}</label>`;
      })
      .join('') || '<span class="empty-hint">暂无区域，请先在下方添加舞台区域</span>';
}

/**
 * 拉取并渲染疏散快照；未启用时显示操作提示。
 * @param {{seq:number, mode:string}|null} guard 全量 / 模式刷新成组调用时传入：
 *   仅当该组仍是最新请求（seq === state.requestSeq）且模式未再变化时才应用结果；
 *   表单提交 / 清除等用户直接操作不传守卫，始终执行。
 */
async function refreshEvacuation(guard = null) {
  const el = $('evacuation-results');
  if (!state.evacuation) {
    state.evacResult = null;
    el.innerHTML = '<p class="empty-hint">输入事件时刻并勾选一个或多个出口区域后，点击「生成疏散快照」。</p>';
    updateExportHref();
    return;
  }
  // 出口区域可能已删除：剔除失效选项；全部失效则停用快照
  const valid = new Set(state.data.areas.map((a) => a.id));
  state.evacuation.exits = state.evacuation.exits.filter((id) => valid.has(id));
  if (state.evacuation.exits.length === 0) {
    state.evacuation = null;
    state.evacResult = null;
    $('evac-clear').classList.add('hidden');
    el.innerHTML = '<p class="empty-hint">所选出口区域已被删除，请重新选择出口后再次生成。</p>';
    updateExportHref();
    renderEvacExitOptions();
    return;
  }
  const reqMode = guard ? guard.mode : state.mode;
  const { time, exits } = state.evacuation;
  const result = await api(
    `/api/evacuation?mode=${reqMode}&time=${time}&exits=${exits.map(encodeURIComponent).join(',')}`
  );
  // 成组请求需「仍是最新请求」；任何路径都要求返回模式与当前模式一致，否则丢弃（A→B→A 同理）
  if (guard && guard.seq !== state.requestSeq) return;
  if (result.mode !== state.mode) return;
  // 等待期间快照可能已被用户清除 / 重新生成：参数已变化则丢弃本次结果
  if (!state.evacuation || state.evacuation.time !== time || state.evacuation.exits.join(',') !== exits.join(',')) {
    return;
  }
  state.evacResult = result;
  renderEvacuation();
  updateExportHref();
}

/** 事件时刻位置单元格 */
function evacPositionHtml(p) {
  if (p.kind === 'corridor') {
    return (
      `<span class="evac-pos">🚶 通道行进中：「${escapeHtml(p.fromName)}」→「${escapeHtml(p.toName)}」</span>` +
      `<span class="time-detail">剩余 ${p.remainingSeconds} 秒，${fmtTime(p.arriveTime)} 抵达「${escapeHtml(p.toName)}」，随后自该区域疏散</span>`
    );
  }
  const icon = p.state === '停留' ? '🧍' : '⏱';
  return (
    `<span class="evac-pos">${icon} ${p.state}：「${escapeHtml(p.areaName)}」</span>` +
    `<span class="time-detail">${escapeHtml(p.reasonText)}，自事件时刻直接疏散</span>`
  );
}

/** 疏散路线单元格：路径链 + 剩余路程 / 逐边时刻与等待标注 */
function evacRouteHtml(e) {
  const ev = e.evacuation;
  const route = ev.path.length > 0 ? escapeHtml(ev.path.join(' → ')) : '—';
  const parts = [];
  if (e.position.kind === 'corridor') {
    parts.push(
      `先按原方向走完剩余 ${e.position.remainingSeconds} 秒，${fmtTime(e.position.arriveTime)} 抵达「${escapeHtml(e.position.toName)}」`
    );
  }
  if (ev.legs.length === 0) {
    parts.push(`已位于出口区域「${escapeHtml(ev.exitName)}」，无需移动`);
  } else {
    parts.push(
      ev.legs
        .map((l) => {
          let s = `${fmtTime(l.departTime)} ${escapeHtml(l.fromName)} → ${fmtTime(l.arriveTime)} ${escapeHtml(l.toName)}`;
          if (l.waitSeconds > 0) s += ` <span class="wait-tag">⏱ 在 ${escapeHtml(l.fromName)} 等待 ${l.waitSeconds} 秒</span>`;
          return s;
        })
        .join('<br>')
    );
  }
  return `${route}<span class="leg-detail">${parts.join('<br>')}</span>`;
}

/** 渲染应急疏散快照：汇总徽章 + 最晚撤离优先的结果表 + 位置未知单列 */
function renderEvacuation() {
  const snap = state.evacResult;
  const el = $('evacuation-results');
  if (!snap) return;
  const s = snap.summary;

  const chips = [
    `<span class="evac-chip">事件时刻 <strong>${fmtTime(snap.eventTime)}</strong></span>`,
    `<span class="evac-chip">出口 <strong>${snap.exits.map((x) => escapeHtml(x.name)).join('、')}</strong></span>`,
    `<span class="evac-chip">模式 <strong>${MODE_NAME[snap.mode]}</strong></span>`,
    `<span class="evac-chip">最晚撤离 <strong>${s.latestArrival === null ? '—' : fmtTime(s.latestArrival)}</strong></span>`,
    `<span class="evac-chip ${s.unreachable ? 'bad' : ''}">无法疏散 <strong>${s.unreachable}</strong></span>`,
    `<span class="evac-chip ${s.unknown ? 'warn' : ''}">位置未知 <strong>${s.unknown}</strong></span>`,
  ].join('');

  const rows = snap.entries
    .map((e) => {
      const pos = evacPositionHtml(e.position);
      if (e.status === 'unreachable') {
        return `<tr class="evac-row-unreachable">
          <td>${escapeHtml(e.actorName)}</td>
          <td>${pos}</td>
          <td colspan="3"><span class="status-pill unreachable">⛔ 无可达出口的路线</span></td>
          <td>—</td>
        </tr>`;
      }
      const ev = e.evacuation;
      return `<tr>
        <td>${escapeHtml(e.actorName)}</td>
        <td>${pos}</td>
        <td>${escapeHtml(ev.exitName)}</td>
        <td>${fmtTime(ev.arrivalTime)}</td>
        <td>${ev.durationSeconds} 秒</td>
        <td class="route">${evacRouteHtml(e)}</td>
      </tr>`;
    })
    .join('');

  const unknownHtml = snap.unknown.length
    ? `<div class="evac-unknown">
        <h4>❓ 位置未知（${snap.unknown.length}）</h4>
        <ul>${snap.unknown.map((u) => `<li><strong>${escapeHtml(u.actorName)}</strong>：${escapeHtml(u.reasonText)}</li>`).join('')}</ul>
      </div>`
    : '';

  el.innerHTML = `
    <div class="evac-chips">${chips}</div>
    <p class="evac-order-hint">按最晚撤离优先排序（无法疏散视为最晚，位置未知单列）；「导出校验报告」将追加同一快照。</p>
    <table>
      <thead><tr><th>演员</th><th>事件时刻位置</th><th>出口</th><th>到达时刻</th><th>耗时</th><th>疏散路线</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty-hint">无位置已知的演员</td></tr>'}</tbody>
    </table>
    ${unknownHtml}`;
}

function bindEvacuation() {
  $('form-evacuation').addEventListener('submit', async (e) => {
    e.preventDefault();
    const time = parseTime($('evac-time').value);
    if (Number.isNaN(time)) {
      toast('事件时刻格式不正确，请输入秒数（如 25）或 mm:ss（如 00:25）', true);
      return;
    }
    const exits = [...$('evac-exits').querySelectorAll('input:checked')].map((i) => i.value);
    if (exits.length === 0) {
      toast('请至少勾选一个出口区域', true);
      return;
    }
    state.evacuation = { time, exits };
    $('evac-clear').classList.remove('hidden');
    try {
      await refreshEvacuation();
      toast('疏散快照已生成，报告将追加同一快照');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('evac-clear').addEventListener('click', () => {
    state.evacuation = null;
    state.evacResult = null;
    $('evac-clear').classList.add('hidden');
    renderEvacExitOptions();
    refreshEvacuation();
    toast('已清除疏散快照');
  });
}

/* ---------- 跨演员口令依赖 ---------- */

const DEP_STATUS_LABEL = {
  satisfied: '✅ 满足',
  violated: '❌ 违约',
  unknown: '❓ 无法判定',
};

/** 口令选项文本：时刻 区域（说明）（演员由下拉分组标题展示） */
function cueOptionText(c) {
  const note = c.note ? `（${c.note}）` : '';
  return `${fmtTime(c.time)} ${escapeHtml(areaName(c.areaId))}${escapeHtml(note)}`;
}

/** 填充依赖表单的两个口令下拉（按演员分组、组内按时间升序） */
function fillDependencySelects() {
  const groups = new Map();
  const sortedCues = state.data.cues.slice().sort((x, y) => x.time - y.time);
  for (const c of sortedCues) {
    const actor = state.data.actors.find((a) => a.id === c.actorId);
    const key = c.actorId;
    if (!groups.has(key)) groups.set(key, { name: actor ? actor.name : '（已删除演员）', cues: [] });
    groups.get(key).cues.push(c);
  }
  const html = [...groups.values()]
    .map(
      (g) =>
        `<optgroup label="${escapeHtml(g.name)}">${g.cues
          .map((c) => `<option value="${c.id}">${cueOptionText(c)}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  $('dep-before').innerHTML = html || '<option value="">暂无口令</option>';
  $('dep-after').innerHTML = html || '<option value="">暂无口令</option>';
}

/** 依赖评估条目取前端兜底描述（评估结果缺失时使用数据文件中的原始口令） */
function fallbackCue(cueId) {
  const c = state.data.cues.find((x) => x.id === cueId);
  if (!c) return { cueId, actorName: '（已删除）', time: null, areaName: '（已删除）', note: '', dwell: 0 };
  return {
    cueId,
    actorName: actorName(c.actorId),
    time: c.time,
    areaName: areaName(c.areaId),
    note: c.note || '',
    dwell: c.dwell > 0 ? c.dwell : 0,
  };
}

function renderDependencyCueCell(cue, dwellVisible) {
  if (!cue || cue.time === null || cue.time === undefined) return escapeHtml('（口令已删除）');
  const cross = cue.crossActorTag || '';
  const note = cue.note ? ` · ${escapeHtml(cue.note)}` : '';
  const dwell = dwellVisible && cue.dwell > 0 ? `<span class="time-detail">停留 ${cue.dwell} 秒</span>` : '';
  return `<strong>${escapeHtml(cue.actorName)}</strong>${cross}<span class="time-detail">${fmtTime(cue.time)} · ${escapeHtml(cue.areaName)}${note}</span>${dwell}`;
}

/** 渲染依赖评估表（随校验结果即时重算） */
function renderDependencies() {
  const v = state.validation;
  const el = $('dependency-results');
  if (!v) return;

  const byId = new Map((v.dependencies?.items || []).map((d) => [d.id, d]));
  const deps = state.data.dependencies || [];

  if (deps.length === 0) {
    el.innerHTML = '<p class="empty-hint">暂无口令依赖。选择前置 / 后置口令并填写至少等待秒数后点击「添加依赖」。</p>';
    fillDependencySelects();
    return;
  }

  const s = v.dependencies ? v.dependencies.summary : { total: deps.length, satisfied: 0, violated: 0, unknown: deps.length };
  const chips = [
    `<span class="dep-chip">依赖 <strong>${s.total}</strong></span>`,
    `<span class="dep-chip ${s.satisfied ? 'good' : ''}">满足 <strong>${s.satisfied}</strong></span>`,
    `<span class="dep-chip ${s.violated ? 'bad' : ''}">违约 <strong>${s.violated}</strong></span>`,
    `<span class="dep-chip ${s.unknown ? 'warn' : ''}">无法判定 <strong>${s.unknown}</strong></span>`,
  ].join('');

  // 渲染顺序与服务端一致：违约 → 无法判定 → 满足；评估结果缺失（极端情况）时补在末尾
  const ordered = v.dependencies
    ? [...v.dependencies.items, ...deps.filter((d) => !byId.has(d.id))]
    : deps;

  const rows = ordered
    .map((raw) => {
      const d = byId.get(raw.id) || {
        id: raw.id,
        waitSeconds: raw.waitSeconds,
        predecessor: fallbackCue(raw.predecessorId),
        successor: fallbackCue(raw.successorId),
        status: 'unknown',
        reason: '当前模式下暂无评估结果',
        completionTime: null,
        successorDepart: null,
        requiredDepart: null,
        delta: null,
      };
      const before = d.predecessor;
      const after = d.successor;
      before.crossActorTag = d.crossActor ? '<span class="cross-tag">跨演员</span>' : '';

      let verdict;
      if (d.status === 'satisfied') {
        verdict = `<span class="status-pill ok">✅ 满足</span><span class="time-detail">余量 ${d.delta} 秒</span>`;
      } else if (d.status === 'violated') {
        verdict = `<span class="status-pill fail">❌ 违约</span><span class="time-detail"><strong>缺口 ${-d.delta} 秒</strong></span>`;
      } else {
        verdict = `<span class="status-pill unreachable">❓ 无法判定</span><span class="time-detail">${escapeHtml(d.reason || '任一端时刻不可得')}</span>`;
      }

      const timeCell =
        d.completionTime === null
          ? '<span class="empty-hint">—</span>'
          : `<span class="time-detail">完成 ${fmtTime(d.completionTime)}</span>` +
            `<span class="time-detail">后置实际出发 ${fmtTime(d.successorDepart)}</span>` +
            `<span class="time-detail">允许最早 ${fmtTime(d.requiredDepart)}</span>`;

      return `<tr class="dep-${d.status}">
        <td>${renderDependencyCueCell(before, true)}</td>
        <td class="dep-wait">≥ <strong>${d.waitSeconds}</strong> 秒</td>
        <td>${renderDependencyCueCell(after, false)}</td>
        <td>${timeCell}</td>
        <td>${verdict}</td>
        <td class="col-ops"><button class="btn btn-danger" data-del-dep="${d.id}">删除</button></td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="dep-chips">${chips}</div>
    <p class="dep-hint">判定口径：前置完成时刻 = 当前模式实际到达 + 停留时长；后置实际出发 = 前往后置口令区段的实际出发；相差秒数 = 后置实际出发 −（前置完成 + 等待）。</p>
    <table class="dep-table">
      <thead><tr><th>前置口令</th><th>至少等待</th><th>后置口令</th><th>时刻对比</th><th>结论 / 相差秒数</th><th class="col-ops">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  fillDependencySelects();
}

function bindDependencies() {
  $('form-dependency').addEventListener('submit', (e) => {
    e.preventDefault();
    const predecessorId = $('dep-before').value;
    const successorId = $('dep-after').value;
    const waitSeconds = Number($('dep-wait').value);
    if (!predecessorId || !successorId) {
      toast('请选择前置口令与后置口令', true);
      return;
    }
    if (predecessorId === successorId) {
      toast('前置与后置不能是同一条口令', true);
      return;
    }
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
      toast('至少等待秒数必须是 0～3600 的整数', true);
      return;
    }
    mutate(
      async () => {
        await api('/api/dependencies', 'POST', { predecessorId, successorId, waitSeconds });
        $('dep-wait').value = '';
      },
      '依赖已添加，已即时重算'
    );
  });

  $('dependency-results').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const id = t.dataset.delDep;
    if (!id) return;
    mutate(() => api(`/api/dependencies/${id}`, 'DELETE'), '依赖已删除，已即时重算');
  });
}

/* ---------- 演员换装核查 ---------- */

const COSTUME_STATUS_LABEL = {
  ok: '✅ 准时',
  fail: '❌ 迟到',
  unreachable: '⛔ 不可达',
  unknown: '❓ 无法评估',
};

/** 当前可登记的相邻口令区段（按演员分组）：与服务端相邻判定同一口径——过滤失效区域后按时间升序，已登记的区段不再出现 */
function availableCostumeSegments() {
  const registered = new Set((state.data.costumeChanges || []).map((t) => `${t.fromCueId}|${t.toCueId}`));
  const areaIds = new Set(state.data.areas.map((a) => a.id));
  const groups = [];
  for (const actor of state.data.actors) {
    const cues = state.data.cues
      .filter((c) => c.actorId === actor.id && areaIds.has(c.areaId))
      .slice()
      .sort((x, y) => x.time - y.time);
    const segments = [];
    for (let i = 0; i + 1 < cues.length; i++) {
      const key = `${cues[i].id}|${cues[i + 1].id}`;
      if (registered.has(key)) continue; // 每个区段最多一项
      segments.push({ key, from: cues[i], to: cues[i + 1] });
    }
    if (segments.length > 0) groups.push({ actor, segments });
  }
  return groups;
}

/** 当前可登记区段键（fromCueId|toCueId）集合，提交前核对用 */
function availableCostumeSegmentKeys() {
  const keys = new Set();
  for (const g of availableCostumeSegments()) for (const s of g.segments) keys.add(s.key);
  return keys;
}

/** 区段选择刚因数据变化失效：占位项持续显示警示文案，直至用户重新选择 */
let ccSegmentInvalidated = false;

/**
 * 填充换装表单：相邻口令区段下拉（按演员分组，已登记的区段不再出现）与换装区域下拉。
 * 重绘时按两条口令 ID 保留仍相邻且未登记的区段选择（换装区域与秒数输入随之保留）；
 * 区段已被登记或因口令 / 区域变化失效时，清空区段选择并提示重新选择，绝不默认选中其他区段。
 */
function fillCostumeSelects() {
  const segSelect = $('cc-segment');
  const prevKey = segSelect.value; // 重建前记住选中的区段键（fromCueId|toCueId）
  const groups = availableCostumeSegments();
  const validKeys = new Set();
  for (const g of groups) for (const s of g.segments) validKeys.add(s.key);

  const stillValid = prevKey !== '' && validKeys.has(prevKey);
  if (prevKey !== '' && !stillValid) ccSegmentInvalidated = true;
  if (stillValid) ccSegmentInvalidated = false;

  const placeholder = ccSegmentInvalidated
    ? '⚠️ 原选择的区段已失效，请重新选择'
    : groups.length > 0
      ? '选择相邻口令区段'
      : '暂无可登记的相邻口令区段';
  segSelect.innerHTML =
    `<option value="" disabled selected>${placeholder}</option>` +
    groups
      .map(
        (g) =>
          `<optgroup label="${escapeHtml(g.actor.name)}">${g.segments
            .map(
              (s) =>
                `<option value="${s.key}">${fmtTime(s.from.time)} ${escapeHtml(areaName(s.from.areaId))} → ` +
                `${fmtTime(s.to.time)} ${escapeHtml(areaName(s.to.areaId))}</option>`
            )
            .join('')}</optgroup>`
      )
      .join('');

  if (stillValid) {
    segSelect.value = prevKey; // 仍相邻且未登记：保留原选择
  } else if (prevKey !== '') {
    segSelect.value = ''; // 已失效：回到占位项，不默认选中其他区段
    toast('之前选择的换装区段已失效（口令 / 区域已变化或该区段已登记），请重新选择', true);
  }
  fillSelect($('cc-area'), state.data.areas, '选择换装区域');
}

/** 单段路线展示：路径链 + 逐边时刻与等待标注（与校验结果路线单元格同口径） */
function costumeLegHtml(leg, label) {
  if (!leg) return '';
  const path = leg.path.length > 0 ? escapeHtml(leg.path.join(' → ')) : '—';
  let detail;
  if (leg.legs.length > 0) {
    detail = leg.legs
      .map((l) => {
        let s = `${fmtTime(l.departTime)} ${escapeHtml(l.fromName)} → ${fmtTime(l.arriveTime)} ${escapeHtml(l.toName)}`;
        if (l.waitSeconds > 0) s += ` <span class="wait-tag">⏱ 在 ${escapeHtml(l.fromName)} 等待 ${l.waitSeconds} 秒</span>`;
        return s;
      })
      .join('<br>');
  } else {
    detail = '<span class="empty-hint">无需移动</span>';
  }
  return `<div class="cc-leg"><span class="cc-leg-label">${label}</span> ${path}<span class="leg-detail">${detail}</span></div>`;
}

/** 渲染换装核查结果（随校验结果与当前模式即时重算） */
function renderCostumeChanges() {
  const el = $('costume-results');
  const tasks = state.data.costumeChanges || [];
  if (tasks.length === 0) {
    el.innerHTML = '<p class="empty-hint">暂无换装任务。选择相邻口令区段、换装区域并填写所需秒数后点击「登记换装任务」。</p>';
    fillCostumeSelects();
    return;
  }

  const evalRes = state.costumeEval;
  const byId = new Map((evalRes ? evalRes.items : []).map((it) => [it.id, it]));
  const s = evalRes
    ? evalRes.summary
    : { total: tasks.length, ok: 0, fail: 0, unreachable: 0, unknown: tasks.length };
  const chips = [
    `<span class="cc-chip">换装任务 <strong>${s.total}</strong></span>`,
    `<span class="cc-chip ${s.ok ? 'good' : ''}">准时 <strong>${s.ok}</strong></span>`,
    `<span class="cc-chip ${s.fail ? 'bad' : ''}">迟到 <strong>${s.fail}</strong></span>`,
    `<span class="cc-chip ${s.unreachable ? 'warn' : ''}">不可达 <strong>${s.unreachable}</strong></span>`,
    `<span class="cc-chip ${s.unknown ? 'warn' : ''}">无法评估 <strong>${s.unknown}</strong></span>`,
  ].join('');

  // 渲染顺序与服务端一致；评估结果缺失（极端情况）时以原始任务兜底补在末尾
  const ordered = evalRes
    ? [...evalRes.items, ...tasks.filter((t) => !byId.has(t.id)).map((t) => t.id)]
    : tasks.map((t) => t.id);

  const rows = ordered
    .map((entry) => {
      const it =
        typeof entry === 'object'
          ? entry
          : byId.get(entry) || (() => {
              const raw = tasks.find((t) => t.id === entry);
              if (!raw) return null;
              const fromCue = state.data.cues.find((c) => c.id === raw.fromCueId);
              const toCue = state.data.cues.find((c) => c.id === raw.toCueId);
              return {
                id: raw.id,
                seconds: raw.seconds,
                actorName: fromCue ? actorName(fromCue.actorId) : '（已删除演员）',
                changeAreaName: areaName(raw.areaId),
                from: { time: fromCue ? fromCue.time : null, areaName: fromCue ? areaName(fromCue.areaId) : '（已删除）', note: fromCue ? fromCue.note || '' : '' },
                to: { time: toCue ? toCue.time : null, areaName: toCue ? areaName(toCue.areaId) : '（已删除）', note: toCue ? toCue.note || '' : '' },
                segmentIndex: null,
                departTime: null,
                reachAreaTime: null,
                changeDoneTime: null,
                finalArrivalTime: null,
                marginSeconds: null,
                status: 'unknown',
                reason: '当前模式下暂无评估结果',
                leg1: null,
                leg2: null,
              };
            })();

      if (!it) return '';
      const segText =
        it.from.time === null || it.from.time === undefined
          ? '（口令已删除）'
          : `${fmtTime(it.from.time)} ${escapeHtml(it.from.areaName)} → ${fmtTime(it.to.time)} ${escapeHtml(it.to.areaName)}`;
      const segCell =
        `<strong>${escapeHtml(it.actorName)}</strong><span class="time-detail">${segText}</span>` +
        (it.segmentIndex !== null && it.segmentIndex !== undefined
          ? `<span class="time-detail">对应校验区段 #${it.segmentIndex}</span>`
          : '');

      let timeCell;
      if (it.departTime === null || it.departTime === undefined) {
        timeCell = '<span class="empty-hint">—</span>';
      } else {
        timeCell = `<span class="time-detail">实际出发 ${fmtTime(it.departTime)}</span>`;
        if (it.reachAreaTime !== null) timeCell += `<span class="time-detail">到达换装区 ${fmtTime(it.reachAreaTime)}</span>`;
        if (it.changeDoneTime !== null) timeCell += `<span class="time-detail">换装完成 <strong>${fmtTime(it.changeDoneTime)}</strong></span>`;
        if (it.finalArrivalTime !== null) timeCell += `<span class="time-detail">最终到达 <strong>${fmtTime(it.finalArrivalTime)}</strong></span>`;
      }

      let marginCell;
      if (it.marginSeconds === null || it.marginSeconds === undefined) {
        marginCell = '<span class="empty-hint">—</span>';
      } else if (it.marginSeconds >= 0) {
        marginCell = `<span class="ontime-tag">余量 ${it.marginSeconds} 秒</span><span class="time-detail">下一口令 ${fmtTime(it.to.time)}</span>`;
      } else {
        marginCell = `<span class="late-tag">缺口 ${-it.marginSeconds} 秒</span><span class="time-detail">下一口令 ${fmtTime(it.to.time)}</span>`;
      }

      const statusCell =
        `<span class="status-pill ${it.status === 'unknown' ? 'unreachable' : it.status}">${COSTUME_STATUS_LABEL[it.status]}</span>` +
        (it.reason ? `<span class="time-detail">${escapeHtml(it.reason)}</span>` : '');

      let routeCell = '<span class="empty-hint">—</span>';
      if (it.leg1 || it.leg2) {
        routeCell =
          (it.leg1 ? costumeLegHtml(it.leg1, '① 起点 → 换装区') : '') +
          (it.leg1 && it.leg2 ? `<span class="cc-change-tag">👔 换装 ${it.seconds} 秒</span>` : '') +
          (it.leg2 ? costumeLegHtml(it.leg2, '② 换装区 → 终点') : '');
      }

      return `<tr class="cc-${it.status}">
        <td>${segCell}</td>
        <td>${escapeHtml(it.changeAreaName)}<span class="time-detail">换装 ${it.seconds} 秒</span></td>
        <td>${timeCell}</td>
        <td>${marginCell}</td>
        <td>${statusCell}</td>
        <td class="route">${routeCell}</td>
        <td class="col-ops"><button class="btn btn-danger" data-del-costume="${it.id}">删除</button></td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="cc-chips">${chips}</div>
    <p class="cc-hint">核查口径：实际出发 = 当前模式下该区段的实际出发时刻；段一「起点 → 换装区」与段二「换装完成 → 终点」分别按时间依赖推演（封闭时段等待 / 绕行计入），最终到达 ≤ 下一口令时刻即准时。仅评估该区段，不改写原走位结果。</p>
    <table class="cc-table">
      <thead><tr><th>演员 / 区段</th><th>换装区域</th><th>时刻链（出发 → 换装 → 到达）</th><th>相对下一口令</th><th>状态</th><th>换装路线（含等待）</th><th class="col-ops">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  fillCostumeSelects();
}

function bindCostume() {
  $('form-costume').addEventListener('submit', (e) => {
    e.preventDefault();
    const seg = $('cc-segment').value;
    const areaId = $('cc-area').value;
    const seconds = Number($('cc-seconds').value);
    if (!seg || !seg.includes('|')) {
      toast('请选择相邻口令区段', true);
      return;
    }
    // 提交前按当前可登记区段核对：失效时阻止提交并清空区段选择，保留换装区域与秒数输入
    if (!availableCostumeSegmentKeys().has(seg)) {
      fillCostumeSelects();
      toast('所选区段已失效（口令 / 区域已变化或该区段已登记），未予登记；请重新选择区段', true);
      return;
    }
    if (!areaId) {
      toast('请选择换装区域', true);
      return;
    }
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      toast('换装所需秒数必须是 0～3600 的整数', true);
      return;
    }
    const [fromCueId, toCueId] = seg.split('|');
    mutate(async () => {
      await api('/api/costume-changes', 'POST', { fromCueId, toCueId, areaId, seconds });
      $('cc-segment').value = ''; // 刚登记的区段不再可登记，回到占位项（避免被误判为失效）
      $('cc-seconds').value = '';
    }, '换装任务已登记，已即时重算');
  });

  // 用户重新选择区段后，清除「原选择已失效」的占位警示
  $('cc-segment').addEventListener('change', () => {
    ccSegmentInvalidated = false;
  });

  $('costume-results').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const id = t.dataset.delCostume;
    if (!id) return;
    mutate(() => api(`/api/costume-changes/${id}`, 'DELETE'), '换装任务已删除，已即时重算');
  });
}

/* ---------- 下拉框选项 ---------- */

function fillSelect(el, items, placeholder) {
  const current = el.value;
  el.innerHTML =
    `<option value="" disabled selected>${placeholder}</option>` +
    items.map((it) => `<option value="${it.id}">${escapeHtml(it.name)}</option>`).join('');
  if (items.some((it) => it.id === current)) el.value = current;
}

function refreshSelects() {
  fillSelect($('edge-a'), state.data.areas, '选择区域 A');
  fillSelect($('edge-b'), state.data.areas, '选择区域 B');
  fillSelect($('cue-actor'), state.data.actors, '选择演员');
  fillSelect($('cue-area'), state.data.areas, '选择目标区域');
  // 吊点下拉按横梁横坐标升序展示
  const rigPointsSorted = (state.data.rigPoints || []).slice().sort((a, b) => a.x - b.x);
  fillSelect($('rigi-left'), rigPointsSorted, '选择左吊点');
  fillSelect($('rigi-right'), rigPointsSorted, '选择右吊点');
}

/* ---------- 封闭时段编辑器 ---------- */

function addClosureRow(start, end) {
  const row = document.createElement('div');
  row.className = 'closure-row';
  row.innerHTML = `
    <input type="number" class="closure-start" min="0" step="1" placeholder="开始(秒)" />
    <span class="closure-sep">~</span>
    <input type="number" class="closure-end" min="0" step="1" placeholder="结束(秒)" />
    <button type="button" class="btn btn-danger btn-remove-closure" title="删除该时段">×</button>
  `;
  if (start !== undefined && start !== null) row.querySelector('.closure-start').value = start;
  if (end !== undefined && end !== null) row.querySelector('.closure-end').value = end;
  row.querySelector('.btn-remove-closure').addEventListener('click', () => row.remove());
  $('closures-list').appendChild(row);
}

function clearClosureRows() {
  $('closures-list').innerHTML = '';
}

/** 收集封闭时段行，返回 { closures } 或 { error } */
function collectClosures() {
  const closures = [];
  for (const row of document.querySelectorAll('#closures-list .closure-row')) {
    const s = row.querySelector('.closure-start').value.trim();
    const e = row.querySelector('.closure-end').value.trim();
    if (s === '' && e === '') continue; // 忽略空行
    const start = Number(s);
    const end = Number(e);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
      return { error: '封闭时段的起止必须是不小于 0 的整数秒' };
    }
    if (start >= end) return { error: '封闭时段的开始秒数必须小于结束秒数' };
    closures.push({ start, end });
  }
  return { closures };
}

/* ---------- 编辑模式 ---------- */

function setEditing(prefix, submitBtn, cancelBtn, isEditing, addText, updateText) {
  $(submitBtn).textContent = isEditing ? updateText : addText;
  $(cancelBtn).classList.toggle('hidden', !isEditing);
  if (!isEditing) $(prefix).value = '';
}

function clearAreaForm() {
  $('form-area').reset();
  setEditing('area-id', 'area-submit', 'area-cancel', false, '添加区域', '保存修改');
}
function clearEdgeForm() {
  $('form-edge').reset();
  clearClosureRows();
  setEditing('edge-id', 'edge-submit', 'edge-cancel', false, '添加连接', '保存修改');
}
function clearActorForm() {
  $('form-actor').reset();
  setEditing('actor-id', 'actor-submit', 'actor-cancel', false, '添加演员', '保存修改');
}
function clearCueForm() {
  $('form-cue').reset();
  setEditing('cue-id', 'cue-submit', 'cue-cancel', false, '添加口令', '保存修改');
}

/* ---------- 提交与变更 ---------- */

async function mutate(fn, successMsg) {
  try {
    await fn();
    const applied = await refresh();
    // 刷新被更新的请求（如快速切换模式 / 再次校验）取代：本次结果未落盘到页面，不提示成功
    if (applied === false) return;
    refreshSelects();
    if (successMsg) toast(successMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindForms() {
  $('form-area').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('area-id').value;
    const body = { name: $('area-name').value.trim(), description: $('area-desc').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/areas/${id}`, 'PUT', body);
      else await api('/api/areas', 'POST', body);
      clearAreaForm();
    }, id ? '区域已更新' : '区域已添加');
  });

  $('form-edge').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('edge-id').value;
    const { closures, error } = collectClosures();
    if (error) {
      toast(error, true);
      return;
    }
    const capacityRaw = $('edge-capacity').value.trim();
    const capacity = capacityRaw === '' ? 1 : Number(capacityRaw);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10) {
      toast('通道容量必须是 1～10 的整数', true);
      return;
    }
    const body = {
      a: $('edge-a').value,
      b: $('edge-b').value,
      seconds: Number($('edge-seconds').value),
      capacity,
      closures,
    };
    mutate(async () => {
      if (id) await api(`/api/edges/${id}`, 'PUT', body);
      else await api('/api/edges', 'POST', body);
      clearEdgeForm();
    }, id ? '连接已更新，已重新校验' : '连接已添加');
  });

  $('form-actor').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('actor-id').value;
    const body = { name: $('actor-name').value.trim(), role: $('actor-role').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/actors/${id}`, 'PUT', body);
      else await api('/api/actors', 'POST', body);
      clearActorForm();
    }, id ? '演员已更新' : '演员已添加');
  });

  $('form-cue').addEventListener('submit', (e) => {
    e.preventDefault();
    const time = parseTime($('cue-time').value);
    if (Number.isNaN(time)) {
      toast('时间格式不正确，请输入秒数（如 90）或 mm:ss（如 01:30）', true);
      return;
    }
    const dwellRaw = $('cue-dwell').value.trim();
    const dwell = dwellRaw === '' ? 0 : Number(dwellRaw);
    if (!Number.isInteger(dwell) || dwell < 0 || dwell > 600) {
      toast('停留时长必须是 0～600 的整数秒', true);
      return;
    }
    const id = $('cue-id').value;
    const body = { actorId: $('cue-actor').value, areaId: $('cue-area').value, time, dwell, note: $('cue-note').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/cues/${id}`, 'PUT', body);
      else await api('/api/cues', 'POST', body);
      clearCueForm();
    }, id ? '口令已更新' : '口令已添加');
  });

  $('area-cancel').addEventListener('click', clearAreaForm);
  $('edge-cancel').addEventListener('click', clearEdgeForm);
  $('actor-cancel').addEventListener('click', clearActorForm);
  $('cue-cancel').addEventListener('click', clearCueForm);
  $('btn-add-closure').addEventListener('click', () => addClosureRow());
}

function bindTableActions() {
  document.body.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const d = t.dataset;
    if (d.editArea) {
      const a = state.data.areas.find((x) => x.id === d.editArea);
      if (!a) return;
      $('area-id').value = a.id;
      $('area-name').value = a.name;
      $('area-desc').value = a.description || '';
      setEditing('area-id', 'area-submit', 'area-cancel', true, '添加区域', '保存修改');
      $('area-name').focus();
    } else if (d.delArea) {
      if (!confirm('删除该区域将同时删除相关连接与口令，确定？')) return;
      mutate(() => api(`/api/areas/${d.delArea}`, 'DELETE'), '区域已删除');
    } else if (d.editEdge) {
      const ed = state.data.edges.find((x) => x.id === d.editEdge);
      if (!ed) return;
      $('edge-id').value = ed.id;
      $('edge-a').value = ed.a;
      $('edge-b').value = ed.b;
      $('edge-seconds').value = ed.seconds;
      $('edge-capacity').value = Number.isInteger(ed.capacity) && ed.capacity >= 1 ? ed.capacity : 1;
      clearClosureRows();
      (Array.isArray(ed.closures) ? ed.closures : []).forEach((c) => addClosureRow(c.start, c.end));
      setEditing('edge-id', 'edge-submit', 'edge-cancel', true, '添加连接', '保存修改');
    } else if (d.delEdge) {
      mutate(() => api(`/api/edges/${d.delEdge}`, 'DELETE'), '连接已删除');
    } else if (d.editActor) {
      const a = state.data.actors.find((x) => x.id === d.editActor);
      if (!a) return;
      $('actor-id').value = a.id;
      $('actor-name').value = a.name;
      $('actor-role').value = a.role || '';
      setEditing('actor-id', 'actor-submit', 'actor-cancel', true, '添加演员', '保存修改');
      $('actor-name').focus();
    } else if (d.delActor) {
      if (!confirm('删除该演员将同时删除其全部口令，确定？')) return;
      mutate(() => api(`/api/actors/${d.delActor}`, 'DELETE'), '演员已删除');
    } else if (d.editCue) {
      const c = state.data.cues.find((x) => x.id === d.editCue);
      if (!c) return;
      $('cue-id').value = c.id;
      $('cue-actor').value = c.actorId;
      $('cue-area').value = c.areaId;
      $('cue-time').value = fmtTime(c.time);
      $('cue-dwell').value = c.dwell || 0;
      $('cue-note').value = c.note || '';
      setEditing('cue-id', 'cue-submit', 'cue-cancel', true, '添加口令', '保存修改');
    } else if (d.delCue) {
      mutate(() => api(`/api/cues/${d.delCue}`, 'DELETE'), '口令已删除');
    } else if (d.editAudience) {
      const a = (state.data.audiencePoints || []).find((x) => x.id === d.editAudience);
      if (!a) return;
      $('aud-id').value = a.id;
      $('aud-name').value = a.name;
      $('aud-x').value = a.x;
      $('aud-y').value = a.y;
      $('aud-eye').value = a.eyeHeight;
      setEditing('aud-id', 'aud-submit', 'aud-cancel', true, '添加观众点', '保存修改');
      $('aud-name').focus();
    } else if (d.delAudience) {
      mutate(() => api(`/api/audiencePoints/${d.delAudience}`, 'DELETE'), '观众点已删除，已重新检查视线');
    } else if (d.editTarget) {
      const t = (state.data.targets || []).find((x) => x.id === d.editTarget);
      if (!t) return;
      $('tgt-id').value = t.id;
      $('tgt-name').value = t.name;
      $('tgt-x').value = t.x;
      $('tgt-y').value = t.y;
      $('tgt-height').value = t.targetHeight;
      setEditing('tgt-id', 'tgt-submit', 'tgt-cancel', true, '添加舞台目标', '保存修改');
      $('tgt-name').focus();
    } else if (d.delTarget) {
      mutate(() => api(`/api/targets/${d.delTarget}`, 'DELETE'), '舞台目标已删除，已重新检查视线');
    } else if (d.editObstacle) {
      const o = (state.data.obstacles || []).find((x) => x.id === d.editObstacle);
      if (!o) return;
      $('obs-id').value = o.id;
      $('obs-name').value = o.name;
      $('obs-x').value = o.x;
      $('obs-y').value = o.y;
      $('obs-width').value = o.width;
      $('obs-depth').value = o.depth;
      $('obs-height').value = o.height;
      setEditing('obs-id', 'obs-submit', 'obs-cancel', true, '添加遮挡物', '保存修改');
      $('obs-name').focus();
    } else if (d.delObstacle) {
      mutate(() => api(`/api/obstacles/${d.delObstacle}`, 'DELETE'), '遮挡物已删除，已重新检查视线');
    } else if (d.editRigpoint) {
      const p = (state.data.rigPoints || []).find((x) => x.id === d.editRigpoint);
      if (!p) return;
      $('rigp-id').value = p.id;
      $('rigp-name').value = p.name;
      $('rigp-x').value = p.x;
      $('rigp-rated').value = p.ratedLoad;
      setEditing('rigp-id', 'rigp-submit', 'rigp-cancel', true, '添加吊点', '保存修改');
      $('rigp-name').focus();
    } else if (d.delRigpoint) {
      // 被吊挂件引用时服务端返回 409 并提示，此处直接发起删除即可
      mutate(() => api(`/api/rigPoints/${d.delRigpoint}`, 'DELETE'), '吊点已删除，已重新核算');
    } else if (d.editRigitem) {
      const it = (state.data.rigItems || []).find((x) => x.id === d.editRigitem);
      if (!it) return;
      $('rigi-id').value = it.id;
      $('rigi-name').value = it.name;
      $('rigi-weight').value = it.weight;
      $('rigi-cog').value = it.cogX;
      $('rigi-left').value = it.leftPointId;
      $('rigi-right').value = it.rightPointId;
      $('rigi-start').value = fmtTime(it.start);
      $('rigi-end').value = fmtTime(it.end);
      setEditing('rigi-id', 'rigi-submit', 'rigi-cancel', true, '添加吊挂件', '保存修改');
      $('rigi-name').focus();
    } else if (d.delRigitem) {
      mutate(() => api(`/api/rigItems/${d.delRigitem}`, 'DELETE'), '吊挂件已删除，已重新核算');
    }
  });
}

function bindHeaderActions() {
  $('btn-refresh').addEventListener('click', () =>
    mutate(async () => {}, '已重新校验')
  );
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('将丢弃当前全部修改并恢复为示例数据，确定？')) return;
    mutate(async () => {
      await api('/api/reset', 'POST');
      clearAreaForm();
      clearEdgeForm();
      clearActorForm();
      clearCueForm();
      clearAudienceForm();
      clearTargetForm();
      clearObstacleForm();
      clearRigPointForm();
      clearRigItemForm();
      state.sightFocus = null;
      $('form-dependency').reset();
      $('form-costume').reset();
      ccSegmentInvalidated = false;
    }, '已恢复示例数据');
  });
  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.mode === state.mode) return;
      setMode(btn.dataset.mode);
      try {
        // 校验 / 换装 / 疏散按切换时模式成组拉取；返回 false 表示已被更新的请求取代，不提示
        const applied = await refreshValidation();
        if (!applied) return;
        const otherMode = state.mode === 'propagate' ? 'classic' : 'propagate';
        const meta = state.validation.baselines || {};
        if (meta[state.mode]) toast(`已切换到「${MODE_NAME[state.mode]}」，已加载该模式基线对比`);
        else if (meta[otherMode]) toast(`「${MODE_NAME[state.mode]}」模式没有基线；另一模式的基线模式不一致，未比较`, true);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  // 基线保存 / 覆盖 / 清除（事件委托，面板随校验结果重绘）
  $('baseline-panel').addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const { baselineSave, baselineClear } = t.dataset;
    if (!baselineSave && !baselineClear) return;
    try {
      if (baselineSave) {
        const overwrite = !!(state.validation.baselines && state.validation.baselines[baselineSave]);
        if (overwrite && !confirm('用当前校验结果覆盖该模式已保存的基线？')) return;
        await api(`/api/baseline/${baselineSave}`, 'POST');
        await refreshValidation();
        toast(overwrite ? '基线已覆盖' : '基线已保存，开始与当前结果对比');
      } else if (baselineClear) {
        if (!confirm('确定清除该模式保存的基线？')) return;
        await api(`/api/baseline/${baselineClear}`, 'DELETE');
        await refreshValidation();
        toast('基线已清除');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- 排练数据 CSV 导入 ---------- */

const IMPORT_ACTOR_TAG = {
  reuse: { cls: 'reuse', text: '复用演员' },
  new: { cls: 'new', text: '新演员' },
  ambiguous: { cls: 'bad', text: '演员重名' },
};
const IMPORT_AREA_TAG = {
  ok: { cls: 'reuse', text: '区域已存在' },
  unknown: { cls: 'bad', text: '未知区域' },
  ambiguous: { cls: 'bad', text: '重名区域' },
};

function renderImportMessage(html = '', isError = false) {
  const el = $('import-message');
  el.className = isError ? 'import-message error' : 'import-message';
  el.innerHTML = html;
}

/** 渲染预览：汇总徽章 + 逐行问题表 + 提交按钮（有错误行时禁用） */
function renderImportPlan(plan) {
  const s = plan.summary;
  const chips = [
    `<span class="imp-chip">数据行 <strong>${s.totalRows}</strong></span>`,
    `<span class="imp-chip ${s.validRows ? 'good' : ''}">可导入 <strong>${s.validRows}</strong></span>`,
    `<span class="imp-chip ${s.errorRows ? 'bad' : ''}">错误行 <strong>${s.errorRows}</strong></span>`,
    `<span class="imp-chip ${s.newActors ? 'new' : ''}">新增演员 <strong>${s.newActors}</strong></span>`,
    `<span class="imp-chip ${s.newCues ? 'new' : ''}">新增口令 <strong>${s.newCues}</strong></span>`,
    `<span class="imp-chip ${s.duplicates ? 'bad' : ''}">文件内重复 <strong>${s.duplicates}</strong></span>`,
    `<span class="imp-chip ${s.conflicts ? 'bad' : ''}">现有口令冲突 <strong>${s.conflicts}</strong></span>`,
  ].join('');

  const rows = plan.rows
    .map((r) => {
      const actorTag = IMPORT_ACTOR_TAG[r.actorStatus];
      const areaTag = IMPORT_AREA_TAG[r.areaStatus];
      const timeCell =
        r.time === null
          ? `<span class="imp-bad">${escapeHtml(r.timeRaw || '（空）')}</span>`
          : `${fmtTime(r.time)}<span class="time-detail">${escapeHtml(r.timeRaw)}</span>`;
      const dwellCell =
        r.dwell === null
          ? `<span class="imp-bad">${escapeHtml(r.dwellRaw)}</span>`
          : r.dwell > 0
            ? `${r.dwell} 秒`
            : '<span class="empty-hint">0</span>';
      const issues = r.issues.length
        ? `<ul class="imp-issues">${r.issues
            .map((i) => `<li data-issue="${i.code}">${escapeHtml(i.message)}</li>`)
            .join('')}</ul>`
        : '<span class="imp-ok">✅ 可导入</span>';
      const firstMark =
        r.firstOccurrence && r.duplicateSeqs && r.duplicateSeqs.length
          ? `<div class="imp-first">📌 文件内首次出现：第 ${r.duplicateSeqs
              .map((n) => escapeHtml(String(n)))
              .join('、')} 数据行与其为同一演员、同一区域、同一时刻（已判为重复行）</div>`
          : '';
      return `<tr class="${r.valid ? 'imp-row-ok' : 'imp-row-err'}">
        <td>${r.seq}</td>
        <td>${escapeHtml(r.name || '（空）')}<span class="time-detail">${escapeHtml(r.role || '无角色')}</span>${
          actorTag ? `<span class="imp-tag ${actorTag.cls}">${actorTag.text}</span>` : ''
        }</td>
        <td>${escapeHtml(r.areaName || '（空）')}${
          areaTag ? `<span class="imp-tag ${areaTag.cls}">${areaTag.text}</span>` : ''
        }</td>
        <td>${timeCell}</td>
        <td>${dwellCell}</td>
        <td>${escapeHtml(r.note || '')}</td>
        <td class="imp-issue-cell">${issues}${firstMark}</td>
      </tr>`;
    })
    .join('');

  const newActorList = plan.newActors.length
    ? `<p class="imp-newactors">将新建演员：${plan.newActors
        .map((a) => `<strong>${escapeHtml(a.name)}</strong>（${escapeHtml(a.role || '无角色')}）`)
        .join('、')}</p>`
    : '';

  const blocked = s.errorRows > 0;
  const hint = blocked
    ? `<p class="imp-blocked">🚫 存在 <strong>${s.errorRows}</strong> 个错误行，已禁止提交；请修正 CSV 后重新上传预览。</p>`
    : `<p class="imp-ready">✅ 全部 <strong>${s.validRows}</strong> 行可导入：将新增 ${s.newActors} 位演员、${s.newCues} 条口令。</p>`;

  $('import-preview').innerHTML = `
    <div class="imp-chips">${chips}</div>
    <p class="imp-version">数据版本：<code>${escapeHtml(plan.version.slice(0, 12))}</code>…（提交时若底库已变化将要求重新预览）</p>
    ${newActorList}
    ${hint}
    <div class="imp-table-wrap">
      <table class="imp-table">
        <thead><tr><th>#</th><th>姓名 / 角色</th><th>目标区域</th><th>时间</th><th>停留</th><th>说明</th><th>校验结果</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  $('import-submit').disabled = blocked;
  $('import-actions').classList.remove('hidden');
}

/** 读取并上传 CSV 生成预览 */
async function previewImport(csv, fileName) {
  const plan = await api('/api/import/preview', 'POST', { csv });
  state.importCsv = csv;
  state.importPlan = plan;
  state.importFileName = fileName;
  $('import-filename').textContent = fileName ? `已选择：${fileName}` : '';
  $('import-clear').classList.remove('hidden');
  renderImportMessage();
  renderImportPlan(plan);
}

function clearImport() {
  state.importCsv = null;
  state.importPlan = null;
  state.importFileName = '';
  $('import-file').value = '';
  $('import-filename').textContent = '';
  $('import-clear').classList.add('hidden');
  $('import-preview').innerHTML = '';
  $('import-actions').classList.add('hidden');
  renderImportMessage();
}

function bindImport() {
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const csv = await file.text();
      await previewImport(csv, file.name);
    } catch (err) {
      renderImportMessage(`❌ ${escapeHtml(err.message)}`, true);
      toast(err.message, true);
    }
  });

  $('import-clear').addEventListener('click', clearImport);

  $('import-submit').addEventListener('click', async () => {
    if (!state.importCsv || !state.importPlan) return;
    if (state.importPlan.summary.errorRows > 0) return;
    try {
      const result = await api('/api/import/commit', 'POST', {
        csv: state.importCsv,
        version: state.importPlan.version,
      });
      const msg = `✅ 导入完成：新增 ${result.createdActors} 位演员、${result.createdCues} 条到位口令，已刷新校验结果。`;
      clearImport();
      const applied = await refresh();
      if (applied === false) return; // 期间已有更新的刷新请求：不展示本次成功提示
      refreshSelects();
      renderImportMessage(msg);
      toast(msg);
    } catch (err) {
      if (err.status === 409) {
        renderImportMessage(
          `⚠️ ${escapeHtml(err.message)}
           <button type="button" class="btn btn-small btn-accent" id="import-repreview">重新预览</button>`,
          true
        );
        $('import-submit').disabled = true;
        toast('底库已变化，请重新预览', true);
      } else {
        renderImportMessage(`❌ ${escapeHtml(err.message)}`, true);
        toast(err.message, true);
      }
    }
  });

  // 409 后点击「重新预览」（事件委托，按钮随消息区重绘）
  $('import-message').addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.id !== 'import-repreview') return;
    if (!state.importCsv) return;
    t.disabled = true;
    try {
      await previewImport(state.importCsv, state.importFileName);
    } catch (err) {
      renderImportMessage(`❌ ${escapeHtml(err.message)}`, true);
      toast(err.message, true);
    }
  });
}

/* ---------- 现场走位复盘 ---------- */

function renderReplayMessage(html = '', isError = false) {
  const el = $('replay-message');
  el.className = isError ? 'import-message error' : 'import-message';
  el.innerHTML = html;
}

/** 时间偏差单元格：正为晚到、负为早到、0 为准时 */
function replayDiffHtml(diff, abs) {
  if (diff === 0) return '<span class="ontime-tag">准时</span>';
  if (diff > 0) return `<span class="late-tag">晚到 ${diff} 秒</span>`;
  return `<span class="early-tag">早到 ${-diff} 秒</span>`;
}

/** 渲染复盘结果：汇总徽章 + 错误行表 + 每位演员的配对 / 漏项 / 多项 */
function renderReplay(result) {
  const s = result.summary;
  const chips = [
    `<span class="imp-chip">数据行 <strong>${s.totalRows}</strong></span>`,
    `<span class="imp-chip ${s.validRows ? 'good' : ''}">有效行 <strong>${s.validRows}</strong></span>`,
    `<span class="imp-chip ${s.errorRows ? 'bad' : ''}">错误行 <strong>${s.errorRows}</strong></span>`,
    `<span class="imp-chip">复盘演员 <strong>${s.actors}</strong></span>`,
    `<span class="imp-chip">配对 <strong>${s.pairs}</strong></span>`,
    `<span class="imp-chip ${s.missedCues ? 'bad' : ''}">漏执行口令 <strong>${s.missedCues}</strong></span>`,
    `<span class="imp-chip ${s.extraActuals ? 'bad' : ''}">多余记录 <strong>${s.extraActuals}</strong></span>`,
    `<span class="imp-chip ${s.areaMismatches ? 'bad' : ''}">区域不符 <strong>${s.areaMismatches}</strong></span>`,
    `<span class="imp-chip">时差合计 <strong>${s.totalTimeDiff}</strong> 秒</span>`,
    `<span class="imp-chip ${s.totalCost ? 'new' : 'good'}">总成本 <strong>${s.totalCost}</strong></span>`,
  ].join('');

  let html = `<div class="imp-chips">${chips}</div>`;
  html += `<p class="imp-version">成本口径：配对时差绝对值 + 区域不符 ${result.costRule.areaMismatchPenalty}/次 + 漏项 / 多项 ${result.costRule.gapPenalty}/条；成本相同先取配对数多者，再取实际记录行号序列字典序较小者。</p>`;

  /* 错误行 */
  const badRows = result.rows.filter((r) => !r.valid);
  if (badRows.length > 0) {
    const errRowsHtml = badRows
      .map(
        (r) => `<tr class="imp-row-err">
          <td>${r.line}</td>
          <td>${escapeHtml(r.name || '（空）')}<span class="time-detail">${escapeHtml(r.role || '无角色')}</span></td>
          <td>${escapeHtml(r.timeRaw || '（空）')}</td>
          <td>${escapeHtml(r.areaName || '（空）')}</td>
          <td><ul class="imp-issues">${r.issues.map((i) => `<li>${escapeHtml(i.message)}</li>`).join('')}</ul></td>
        </tr>`
      )
      .join('');
    html += `<div class="replay-group">
      <h4>🚫 解析失败的数据行（${badRows.length} 行，不参与对齐）</h4>
      <div class="imp-table-wrap">
        <table class="imp-table">
          <thead><tr><th>CSV 行号</th><th>演员姓名 / 角色</th><th>实际时刻</th><th>实际区域</th><th>问题</th></tr></thead>
          <tbody>${errRowsHtml}</tbody>
        </table>
      </div>
    </div>`;
  } else {
    html += '<p class="imp-ready">✅ 全部数据行均解析为现有演员与现有区域。</p>';
  }

  /* 每位演员 */
  if (result.actors.length === 0) {
    html += '<p class="empty-hint">没有可复盘的演员（有效行与计划口令均为空）。</p>';
  }
  html += result.actors
    .map((a) => {
      const role = a.actorRole ? `<span class="cue-count">（${escapeHtml(a.actorRole)}）</span>` : '';
      const head = `<h3>${escapeHtml(a.actorName)} ${role}
        <span class="cue-count">计划 ${a.cueCount} 条 / 实际 ${a.actualCount} 条 · 配对 ${a.pairs.length} · 漏 ${a.missed.length} · 多 ${a.extra.length}</span>
        <span class="replay-cost">总成本 ${a.cost.total}</span>
        <span class="time-detail">时差 ${a.cost.timeDiff} 秒 · 区域罚分 ${a.cost.areaPenalty} · 漏项/多项罚分 ${a.cost.gapPenalty}</span>
      </h3>`;

      let body = '';
      if (a.pairs.length > 0) {
        const pairRows = a.pairs
          .map(
            (p, idx) => `<tr class="${p.areaMatch ? '' : 'replay-row-mismatch'}">
              <td>${idx + 1}</td>
              <td>${fmtTime(p.cueTime)}<span class="time-detail">${escapeHtml(p.cueAreaName)}${p.cueNote ? ' · ' + escapeHtml(p.cueNote) : ''}</span></td>
              <td>${p.actualLine}</td>
              <td>${fmtTime(p.actualTime)}<span class="time-detail">${escapeHtml(p.actualAreaName)}</span></td>
              <td>${replayDiffHtml(p.timeDiff, p.timeDiffAbs)}<span class="time-detail">差 ${p.timeDiffAbs} 秒</span></td>
              <td>${p.areaMatch ? '<span class="imp-ok">✅ 一致</span>' : `<span class="imp-bad">❌ 不符（+${result.costRule.areaMismatchPenalty}）</span>`}</td>
              <td>${p.cost}</td>
            </tr>`
          )
          .join('');
        body += `<div class="replay-pairs">
          <table>
            <thead><tr><th>#</th><th>计划口令</th><th>CSV 行号</th><th>实际记录</th><th>时间偏差</th><th>区域偏差</th><th>配对成本</th></tr></thead>
            <tbody>${pairRows}</tbody>
          </table>
        </div>`;
      }

      if (a.missed.length > 0) {
        body += `<div class="replay-sub">
          <h5 class="replay-miss-title">漏执行口令（${a.missed.length}，每条 +${result.costRule.gapPenalty}）</h5>
          <ul class="replay-items">
            ${a.missed
              .map((c) => `<li><span class="late-tag">${fmtTime(c.cueTime)}</span> ${escapeHtml(c.cueAreaName)}${c.cueNote ? ` · ${escapeHtml(c.cueNote)}` : ''}</li>`)
              .join('')}
          </ul>
        </div>`;
      }

      if (a.extra.length > 0) {
        body += `<div class="replay-sub">
          <h5 class="replay-extra-title">多余实际记录（${a.extra.length}，每条 +${result.costRule.gapPenalty}）</h5>
          <ul class="replay-items">
            ${a.extra
              .map((e) => `<li><span class="early-tag">第 ${e.actualLine} 行</span> ${fmtTime(e.actualTime)} ${escapeHtml(e.actualAreaName)}</li>`)
              .join('')}
          </ul>
        </div>`;
      }

      if (!body) body = '<p class="empty-hint">该演员没有计划口令也没有有效实际记录。</p>';
      return `<div class="actor-block replay-actor">${head}${body}</div>`;
    })
    .join('');

  $('replay-results').innerHTML = html;
}

async function analyzeReplay(csv, fileName) {
  const result = await api('/api/replay/analyze', 'POST', { csv });
  state.replayCsv = csv;
  state.replayResult = result;
  state.replayFileName = fileName;
  $('replay-filename').textContent = fileName ? `已选择：${fileName}` : '';
  $('replay-clear').classList.remove('hidden');
  $('replay-download').classList.remove('hidden');
  $('replay-download').disabled = false;
  renderReplayMessage();
  renderReplay(result);
}

function clearReplay() {
  state.replayCsv = null;
  state.replayResult = null;
  state.replayFileName = '';
  $('replay-file').value = '';
  $('replay-filename').textContent = '';
  $('replay-clear').classList.add('hidden');
  $('replay-download').classList.add('hidden');
  $('replay-download').disabled = true;
  $('replay-results').innerHTML = '';
  renderReplayMessage();
}

/** 下载本次复盘 Markdown：CSV 原文 POST 到服务端重新计算后下载（不依赖页面结果快照） */
async function downloadReplayReport(csv) {
  const res = await fetch('/api/replay/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `下载失败（${res.status}）`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '现场走位复盘报告.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function bindReplay() {
  $('replay-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const csv = await file.text();
      await analyzeReplay(csv, file.name);
    } catch (err) {
      renderReplayMessage(`❌ ${escapeHtml(err.message)}`, true);
      toast(err.message, true);
    }
  });

  $('replay-clear').addEventListener('click', () => {
    clearReplay();
    toast('已清空复盘结果');
  });

  $('replay-download').addEventListener('click', async () => {
    if (!state.replayCsv) return;
    try {
      await downloadReplayReport(state.replayCsv);
      toast('已下载本次复盘 Markdown');
    } catch (err) {
      renderReplayMessage(`❌ ${escapeHtml(err.message)}`, true);
      toast(err.message, true);
    }
  });
}

/* ---------- 观众视线遮挡检查 ---------- */

function pairKey(p) {
  return `${p.audienceId}|${p.targetId}`;
}

/** 参数 t 显示：有限小数直接显示，否则保留 4 位小数并附精确分数（服务端按分数精确裁剪） */
function fmtT(f) {
  const dec = (f.num / f.den).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return (f.num * 10000) % f.den === 0 ? dec : `${dec}…（=${f.num}/${f.den}）`;
}

function renderSightSummary() {
  const s = state.sightlines && state.sightlines.summary;
  if (!s) return;
  $('sight-summary').innerHTML = `
    <div class="badge"><span class="num">${s.audiencePoints}</span><span class="label">观众点</span></div>
    <div class="badge"><span class="num">${s.targets}</span><span class="label">舞台目标</span></div>
    <div class="badge"><span class="num">${s.obstacles}</span><span class="label">遮挡物</span></div>
    <div class="badge"><span class="num">${s.pairs}</span><span class="label">视线对</span></div>
    <div class="badge ok"><span class="num">${s.clear}</span><span class="label">通视</span></div>
    <div class="badge fail"><span class="num">${s.blocked}</span><span class="label">被挡</span></div>
    <div class="badge warn"><span class="num">${s.notClearable}</span><span class="label">无法抬高解决</span></div>
  `;
}

/** 网格步长：1/2/5 × 10^k */
function niceStep(range, count) {
  const raw = range / count;
  if (!isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

/** SVG 平面图：遮挡物矩形、观众点、舞台目标与逐对视线（y 轴向上） */
function renderSightMap() {
  const el = $('sight-map');
  const audiences = state.data.audiencePoints || [];
  const targets = state.data.targets || [];
  const obstacles = state.data.obstacles || [];
  if (!audiences.length && !targets.length && !obstacles.length) {
    el.innerHTML = '<p class="empty-hint">暂无数据：请在下方「观众点 / 舞台目标 / 遮挡物」面板中添加，平面图与逐对分析将自动生成。</p>';
    return;
  }

  const xs = [];
  const ys = [];
  audiences.forEach((a) => { xs.push(a.x); ys.push(a.y); });
  targets.forEach((t) => { xs.push(t.x); ys.push(t.y); });
  obstacles.forEach((o) => { xs.push(o.x, o.x + o.width); ys.push(o.y, o.y + o.depth); });
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const padX = Math.max(60, (maxX - minX) * 0.1);
  const padY = Math.max(60, (maxY - minY) * 0.16);
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  const W = maxX - minX;
  const H = maxY - minY;
  const X = (x) => x - minX;
  const Y = (y) => maxY - y; // 平面图的 y 轴向上
  const u = Math.max(W, H) / 100; // 相对单位：字号与标记尺寸随视图缩放

  // 网格与坐标刻度（厘米）
  const step = niceStep(Math.max(W, H), 8);
  let grid = '';
  for (let k = Math.ceil(minX / step); k * step <= maxX; k++) {
    const gx = k * step;
    grid += `<line class="sl-grid" x1="${X(gx)}" y1="0" x2="${X(gx)}" y2="${H}" />`;
    grid += `<text class="sl-grid-label" x="${X(gx)}" y="${H - u * 0.5}" font-size="${u * 1.05}" text-anchor="middle">${gx}</text>`;
  }
  for (let k = Math.ceil(minY / step); k * step <= maxY; k++) {
    const gy = k * step;
    grid += `<line class="sl-grid" x1="0" y1="${Y(gy)}" x2="${W}" y2="${Y(gy)}" />`;
    grid += `<text class="sl-grid-label" x="${u * 0.5}" y="${Y(gy) + u * 0.4}" font-size="${u * 1.05}">${gy}</text>`;
  }

  // 遮挡物（某视线首挡物加粗高亮）
  const firstIds = new Set(
    (state.sightlines ? state.sightlines.pairs : [])
      .filter((p) => p.firstObstacle)
      .map((p) => p.firstObstacle.id)
  );
  const obsSvg = obstacles
    .map((o) => {
      const cls = firstIds.has(o.id) ? 'sl-obstacle first-blocker' : 'sl-obstacle';
      return `<rect class="${cls}" x="${X(o.x)}" y="${Y(o.y + o.depth)}" width="${o.width}" height="${o.depth}" />` +
        `<text class="sl-label" x="${X(o.x + o.width / 2)}" y="${Y(o.y + o.depth) + u * 1.5}" font-size="${u * 1.2}" text-anchor="middle">${escapeHtml(o.name)} · 高${o.height}</text>`;
    })
    .join('');

  // 视线（含透明加宽的点击热区）
  const pairs = state.sightlines ? state.sightlines.pairs : [];
  const linesSvg = pairs
    .map((p) => {
      const a = audiences.find((x) => x.id === p.audienceId);
      const t = targets.find((x) => x.id === p.targetId);
      if (!a || !t) return '';
      const key = pairKey(p);
      const cls = p.status === 'clear' ? 'clear' : p.clearable ? 'blocked' : 'infeasible';
      const focused = state.sightFocus === key ? ' focused' : '';
      const statusText = p.status === 'clear' ? '通视' : p.clearable ? '被挡' : '被挡 · 无法抬高解决';
      const title = `${p.audienceName} → ${p.targetName}：${statusText}`;
      return `<line class="sl-line ${cls}${focused}" data-pair="${key}" x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(t.x)}" y2="${Y(t.y)}"><title>${escapeHtml(title)}</title></line>` +
        `<line class="sl-hit" data-pair="${key}" x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(t.x)}" y2="${Y(t.y)}"><title>${escapeHtml(title)}</title></line>`;
    })
    .join('');

  const audSvg = audiences
    .map(
      (a) =>
        `<circle class="sl-audience" cx="${X(a.x)}" cy="${Y(a.y)}" r="${u * 0.85}" />` +
        `<text class="sl-label" x="${X(a.x)}" y="${Y(a.y) + u * 2.3}" font-size="${u * 1.2}" text-anchor="middle">${escapeHtml(a.name)}（眼高${a.eyeHeight}）</text>`
    )
    .join('');

  const d = u * 1.05;
  const tgtSvg = targets
    .map(
      (t) =>
        `<path class="sl-target" d="M ${X(t.x)} ${Y(t.y) - d} L ${X(t.x) + d} ${Y(t.y)} L ${X(t.x)} ${Y(t.y) + d} L ${X(t.x) - d} ${Y(t.y)} Z" />` +
        `<text class="sl-label" x="${X(t.x)}" y="${Y(t.y) - u * 1.7}" font-size="${u * 1.2}" text-anchor="middle">${escapeHtml(t.name)}（目标高${t.targetHeight}）</text>`
    )
    .join('');

  el.innerHTML =
    `<svg class="sight-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="观众视线平面图">` +
    grid + obsSvg + linesSvg + audSvg + tgtSvg +
    '</svg>';
}

/** 逐对分析表：首挡物、相交区间与建议抬高量 */
function renderSightTable() {
  const el = $('sight-results');
  const res = state.sightlines;
  if (!res) return;
  const audiences = state.data.audiencePoints || [];
  const targets = state.data.targets || [];
  if (!audiences.length || !targets.length) {
    el.innerHTML = '<p class="empty-hint">请至少添加一个观众点与一个舞台目标，即可自动生成逐对视线分析。</p>';
    return;
  }

  const rows = res.pairs
    .map((p) => {
      const key = pairKey(p);
      const statusCell =
        p.status === 'clear'
          ? '<span class="status-pill ok">🟢 通视</span>'
          : p.clearable
            ? '<span class="status-pill fail">🔴 被挡</span>'
            : '<span class="status-pill unreachable">🚫 被挡 · 无法抬高解决</span>';
      const firstCell = p.firstObstacle
        ? `<strong>${escapeHtml(p.firstObstacle.name)}</strong><span class="time-detail">进入 t=${fmtT(p.firstObstacle.enter)} · 高 ${p.firstObstacle.height} cm</span>`
        : '<span class="empty-hint">—</span>';
      const intsCell = p.intersections.length
        ? `<ul class="sight-int-list">${p.intersections
            .map(
              (i) =>
                `<li class="${i.blocking ? 'sight-int-blocking' : ''}">${escapeHtml(i.obstacleName)} ` +
                `<code>[${fmtT(i.enter)} ~ ${fmtT(i.exit)}]</code> · 高 ${i.height} cm` +
                `${i.blocking ? ' · <strong>🔺遮挡</strong>' : ' · 未遮挡'}</li>`
            )
            .join('')}</ul>`
        : '<span class="empty-hint">无相交遮挡物</span>';
      let suggestCell;
      if (!p.clearable) {
        suggestCell =
          '<span class="sight-infeasible">无法通过抬高目标解决</span>' +
          `<span class="time-detail">眼高不高于「${escapeHtml(p.notClearableBy)}」，且视线起点位于其投影内</span>`;
      } else if (p.requiredTargetHeight === null) {
        suggestCell = '<span class="empty-hint">无相交遮挡物，无需抬高</span>';
      } else if (p.raiseBy > 0) {
        suggestCell =
          `<strong>抬高至 ≥ ${p.requiredTargetHeight} cm</strong>` +
          `<span class="time-detail">建议抬高 +${p.raiseBy} cm（当前 ${p.targetHeight} cm）</span>`;
      } else {
        suggestCell =
          '<span class="ontime-tag">无需抬高</span>' +
          `<span class="time-detail">严格越过的最小目标高为 ${p.requiredTargetHeight} cm，当前 ${p.targetHeight} cm 已满足</span>`;
      }
      const rowCls = p.status === 'clear' ? 'sight-row-clear' : p.clearable ? 'sight-row-blocked' : 'sight-row-infeasible';
      const focused = state.sightFocus === key ? ' row-focused' : '';
      return `<tr class="${rowCls}${focused}" data-pair="${key}">
        <td><strong>${escapeHtml(p.audienceName)}</strong><span class="time-detail">眼高 ${p.eyeHeight} cm</span> → <strong>${escapeHtml(p.targetName)}</strong></td>
        <td>${statusCell}</td>
        <td>${firstCell}</td>
        <td>${intsCell}</td>
        <td>${p.targetHeight} cm</td>
        <td>${suggestCell}</td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `<table class="sight-table">
    <thead><tr><th>观众点 → 目标</th><th>状态</th><th>首挡物（最小进入参数）</th><th>相交遮挡物（参数区间 · 高度）</th><th>目标高</th><th>建议抬高（严格越过的最小整数目标高）</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderSightlines() {
  renderSightSummary();
  renderSightMap();
  renderSightTable();
}

/** 高亮（或取消高亮）某条视线，并按需滚动到平面图 / 表格行 */
function focusSightPair(key, scrollTo) {
  state.sightFocus = state.sightFocus === key ? null : key;
  document
    .querySelectorAll('#sight-map .sl-line')
    .forEach((el) => el.classList.toggle('focused', el.dataset.pair === state.sightFocus));
  document
    .querySelectorAll('#sight-results tr[data-pair]')
    .forEach((el) => el.classList.toggle('row-focused', el.dataset.pair === state.sightFocus));
  if (!state.sightFocus) return;
  if (scrollTo === 'table') {
    const row = document.querySelector(`#sight-results tr[data-pair="${CSS.escape(state.sightFocus)}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (scrollTo === 'map') {
    $('sight-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function bindSightMap() {
  $('sight-map').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const line = t.closest('[data-pair]');
    if (line) focusSightPair(line.dataset.pair, 'table');
  });
  $('sight-results').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const row = t.closest('tr[data-pair]');
    if (row) focusSightPair(row.dataset.pair, 'map');
  });
}

/* ---------- 观众点 / 舞台目标 / 遮挡物 管理 ---------- */

function renderAudiencePoints() {
  $('audience-tbody').innerHTML =
    (state.data.audiencePoints || [])
      .map(
        (a) => `<tr>
          <td>${escapeHtml(a.name)}</td>
          <td>${a.x}</td>
          <td>${a.y}</td>
          <td>${a.eyeHeight} cm</td>
          <td class="col-ops">
            <button class="btn btn-small" data-edit-audience="${a.id}">编辑</button>
            <button class="btn btn-danger" data-del-audience="${a.id}">删除</button>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5" class="empty-hint">暂无观众点</td></tr>';
}

function renderTargets() {
  $('targets-tbody').innerHTML =
    (state.data.targets || [])
      .map(
        (t) => `<tr>
          <td>${escapeHtml(t.name)}</td>
          <td>${t.x}</td>
          <td>${t.y}</td>
          <td>${t.targetHeight} cm</td>
          <td class="col-ops">
            <button class="btn btn-small" data-edit-target="${t.id}">编辑</button>
            <button class="btn btn-danger" data-del-target="${t.id}">删除</button>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5" class="empty-hint">暂无舞台目标</td></tr>';
}

function renderObstacles() {
  $('obstacles-tbody').innerHTML =
    (state.data.obstacles || [])
      .map(
        (o) => `<tr>
          <td>${escapeHtml(o.name)}</td>
          <td>${o.x}</td>
          <td>${o.y}</td>
          <td>${o.width}</td>
          <td>${o.depth}</td>
          <td>${o.height} cm</td>
          <td class="col-ops">
            <button class="btn btn-small" data-edit-obstacle="${o.id}">编辑</button>
            <button class="btn btn-danger" data-del-obstacle="${o.id}">删除</button>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="7" class="empty-hint">暂无遮挡物</td></tr>';
}

function clearAudienceForm() {
  $('form-audience').reset();
  setEditing('aud-id', 'aud-submit', 'aud-cancel', false, '添加观众点', '保存修改');
}
function clearTargetForm() {
  $('form-target').reset();
  setEditing('tgt-id', 'tgt-submit', 'tgt-cancel', false, '添加舞台目标', '保存修改');
}
function clearObstacleForm() {
  $('form-obstacle').reset();
  setEditing('obs-id', 'obs-submit', 'obs-cancel', false, '添加遮挡物', '保存修改');
}

/** 读取整数厘米输入；非法时 toast 并返回 null */
function readCmInputs(fields) {
  const out = {};
  for (const [key, id, label] of fields) {
    const raw = $(id).value.trim();
    if (!/^-?\d+$/.test(raw)) {
      toast(`${label}必须是整数厘米`, true);
      return null;
    }
    out[key] = parseInt(raw, 10);
  }
  return out;
}

function bindSightlineForms() {
  $('form-audience').addEventListener('submit', (e) => {
    e.preventDefault();
    const cm = readCmInputs([
      ['x', 'aud-x', '坐标 x'],
      ['y', 'aud-y', '坐标 y'],
      ['eyeHeight', 'aud-eye', '眼高'],
    ]);
    if (!cm) return;
    const id = $('aud-id').value;
    const body = { name: $('aud-name').value.trim(), ...cm };
    mutate(async () => {
      if (id) await api(`/api/audiencePoints/${id}`, 'PUT', body);
      else await api('/api/audiencePoints', 'POST', body);
      clearAudienceForm();
    }, id ? '观众点已更新，已重新检查视线' : '观众点已添加');
  });

  $('form-target').addEventListener('submit', (e) => {
    e.preventDefault();
    const cm = readCmInputs([
      ['x', 'tgt-x', '坐标 x'],
      ['y', 'tgt-y', '坐标 y'],
      ['targetHeight', 'tgt-height', '目标高'],
    ]);
    if (!cm) return;
    const id = $('tgt-id').value;
    const body = { name: $('tgt-name').value.trim(), ...cm };
    mutate(async () => {
      if (id) await api(`/api/targets/${id}`, 'PUT', body);
      else await api('/api/targets', 'POST', body);
      clearTargetForm();
    }, id ? '舞台目标已更新，已重新检查视线' : '舞台目标已添加');
  });

  $('form-obstacle').addEventListener('submit', (e) => {
    e.preventDefault();
    const cm = readCmInputs([
      ['x', 'obs-x', '坐标 x'],
      ['y', 'obs-y', '坐标 y'],
      ['width', 'obs-width', '宽'],
      ['depth', 'obs-depth', '深'],
      ['height', 'obs-height', '高'],
    ]);
    if (!cm) return;
    if (cm.width < 1 || cm.depth < 1) {
      toast('遮挡物的宽、深必须是不小于 1 的整数厘米', true);
      return;
    }
    const id = $('obs-id').value;
    const body = { name: $('obs-name').value.trim(), ...cm };
    mutate(async () => {
      if (id) await api(`/api/obstacles/${id}`, 'PUT', body);
      else await api('/api/obstacles', 'POST', body);
      clearObstacleForm();
    }, id ? '遮挡物已更新，已重新检查视线' : '遮挡物已添加');
  });

  $('aud-cancel').addEventListener('click', clearAudienceForm);
  $('tgt-cancel').addEventListener('click', clearTargetForm);
  $('obs-cancel').addEventListener('click', clearObstacleForm);
}

/* ---------- 吊挂布景载荷核算 ---------- */

/** 载荷显示：整数直接显示，否则保留 2 位小数并附精确分数（服务端按分数精确累计） */
function fmtLoad(f) {
  // num/den 可能长达数百位（多件质数间距分担叠加），一律按 BigInt 处理，
  // 两位小数直接取服务端分数精确舍入的 kg，不把巨大分子 / 分母转浮点再相除
  const num = BigInt(f.num);
  const den = BigInt(f.den);
  if (den === 1n) return num.toString();
  const dec = f.kg.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return (num * 100n) % den === 0n ? dec : `${dec}…（=${f.num}/${f.den}）`;
}

function rigPointName(id) {
  const p = (state.data.rigPoints || []).find((x) => x.id === id);
  return p ? p.name : '（已删除）';
}

function renderRigSummary() {
  const s = state.rigging && state.rigging.summary;
  if (!s) return;
  $('rig-summary').innerHTML = `
    <div class="badge"><span class="num">${s.points}</span><span class="label">吊点</span></div>
    <div class="badge"><span class="num">${s.items}</span><span class="label">吊挂件</span></div>
    <div class="badge ${s.overloadedPoints ? 'fail' : 'ok'}"><span class="num">${s.overloadedPoints}</span><span class="label">超额吊点</span></div>
    <div class="badge ${s.overloadIntervals ? 'fail' : 'ok'}"><span class="num">${s.overloadIntervals}</span><span class="label">超额区间</span></div>
  `;
}

/** 逐吊点核算结果表：峰值载荷、状态与合并后的超额区间（含超额量） */
function renderRigPointResults() {
  const res = state.rigging;
  if (!res) return;
  if (res.points.length === 0) {
    $('rig-results').innerHTML = '<p class="empty-hint">暂无吊点：请在下方「吊点（同一横梁）」面板添加吊点，再维护吊挂件。</p>';
    return;
  }
  const rows = res.points
    .map((p) => {
      const statusCell = p.overloaded
        ? '<span class="status-pill fail">⚠ 超额</span>'
        : '<span class="status-pill ok">✅ 正常</span>';
      const peakCell =
        `${fmtLoad(p.peak)} kg` +
        (p.peakInterval
          ? `<span class="time-detail">首次出现于 ${fmtTime(p.peakInterval.start)} ~ ${fmtTime(p.peakInterval.end)}</span>`
          : '');
      const ivCell = p.intervals.length
        ? `<ul class="rig-interval-list">${p.intervals
            .map(
              (iv) =>
                `<li><code>[${fmtTime(iv.start)}, ${fmtTime(iv.end)})</code> · ${iv.durationSeconds} 秒` +
                `<span class="time-detail">区间峰值 ${fmtLoad(iv.peakLoad)} kg · <strong>超额 ${fmtLoad(iv.excess)} kg</strong></span></li>`
            )
            .join('')}</ul>`
        : '<span class="empty-hint">无超额区间</span>';
      return `<tr class="${p.overloaded ? 'rig-row-over' : 'rig-row-ok'}">
        <td><strong>${escapeHtml(p.name)}</strong><span class="time-detail">横坐标 ${p.x} cm</span></td>
        <td>${p.ratedLoad} kg</td>
        <td>${peakCell}</td>
        <td>${statusCell}</td>
        <td>${ivCell}</td>
      </tr>`;
    })
    .join('');
  $('rig-results').innerHTML = `<table class="rig-table">
    <thead><tr><th>吊点</th><th>额定载荷</th><th>峰值载荷</th><th>状态</th><th>超额区间（已合并相邻连续超额）· 超额量</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** 吊挂件分担明细表：每件对左 / 右吊点的力矩平衡分担重量 */
function renderRigItemShares() {
  const res = state.rigging;
  if (!res) return;
  if (res.items.length === 0) {
    $('rig-item-shares').innerHTML = '<p class="empty-hint">暂无吊挂件，添加后将在此列出每件对两吊点的分担重量。</p>';
    return;
  }
  const rows = res.items
    .map(
      (it) => `<tr>
        <td><strong>${escapeHtml(it.name)}</strong><span class="time-detail">生效 [${fmtTime(it.start)}, ${fmtTime(it.end)})</span></td>
        <td>${it.weight} kg</td>
        <td>${it.cogX} cm</td>
        <td>${escapeHtml(it.leftPointName)}<span class="time-detail">${fmtLoad(it.leftShare)} kg</span></td>
        <td>${escapeHtml(it.rightPointName)}<span class="time-detail">${fmtLoad(it.rightShare)} kg</span></td>
      </tr>`
    )
    .join('');
  $('rig-item-shares').innerHTML = `<h3 class="rig-share-title">吊挂件分担明细（力矩平衡，两吊点分担之和恒等于重量）</h3>
    <table class="rig-table">
      <thead><tr><th>吊挂件（生效时段）</th><th>重量</th><th>重心横坐标</th><th>左吊点 · 分担</th><th>右吊点 · 分担</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRigging() {
  renderRigSummary();
  renderRigPointResults();
  renderRigItemShares();
}

/* ---------- 吊点 / 吊挂件 管理 ---------- */

function renderRigPoints() {
  $('rigpoints-tbody').innerHTML =
    (state.data.rigPoints || [])
      .slice()
      .sort((a, b) => a.x - b.x || a.name.localeCompare(b.name, 'zh'))
      .map(
        (p) => `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${p.x} cm</td>
          <td>${p.ratedLoad} kg</td>
          <td class="col-ops">
            <button class="btn btn-small" data-edit-rigpoint="${p.id}">编辑</button>
            <button class="btn btn-danger" data-del-rigpoint="${p.id}">删除</button>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="4" class="empty-hint">暂无吊点</td></tr>';
}

function renderRigItems() {
  $('rigitems-tbody').innerHTML =
    (state.data.rigItems || [])
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name, 'zh'))
      .map(
        (it) => `<tr>
          <td>${escapeHtml(it.name)}</td>
          <td>${it.weight} kg</td>
          <td>${it.cogX} cm</td>
          <td>${escapeHtml(rigPointName(it.leftPointId))}</td>
          <td>${escapeHtml(rigPointName(it.rightPointId))}</td>
          <td>${fmtTime(it.start)} ~ ${fmtTime(it.end)}</td>
          <td class="col-ops">
            <button class="btn btn-small" data-edit-rigitem="${it.id}">编辑</button>
            <button class="btn btn-danger" data-del-rigitem="${it.id}">删除</button>
          </td>
        </tr>`
      )
      .join('') || '<tr><td colspan="7" class="empty-hint">暂无吊挂件</td></tr>';
}

function clearRigPointForm() {
  $('form-rigpoint').reset();
  setEditing('rigp-id', 'rigp-submit', 'rigp-cancel', false, '添加吊点', '保存修改');
}
function clearRigItemForm() {
  $('form-rigitem').reset();
  setEditing('rigi-id', 'rigi-submit', 'rigi-cancel', false, '添加吊挂件', '保存修改');
}

/** 读取整数输入；非法时 toast 并返回 null（label 需含单位，如「重量（千克）」） */
function readIntInputs(fields) {
  const out = {};
  for (const [key, id, label] of fields) {
    const raw = $(id).value.trim();
    if (!/^-?\d+$/.test(raw)) {
      toast(`${label}必须是整数`, true);
      return null;
    }
    out[key] = parseInt(raw, 10);
  }
  return out;
}

function bindRigForms() {
  $('form-rigpoint').addEventListener('submit', (e) => {
    e.preventDefault();
    const vals = readIntInputs([
      ['x', 'rigp-x', '横坐标（厘米）'],
      ['ratedLoad', 'rigp-rated', '额定载荷（千克）'],
    ]);
    if (!vals) return;
    const id = $('rigp-id').value;
    const body = { name: $('rigp-name').value.trim(), ...vals };
    mutate(async () => {
      if (id) await api(`/api/rigPoints/${id}`, 'PUT', body);
      else await api('/api/rigPoints', 'POST', body);
      clearRigPointForm();
    }, id ? '吊点已更新，已重新核算' : '吊点已添加');
  });

  $('form-rigitem').addEventListener('submit', (e) => {
    e.preventDefault();
    const vals = readIntInputs([
      ['weight', 'rigi-weight', '重量（千克）'],
      ['cogX', 'rigi-cog', '重心横坐标（厘米）'],
    ]);
    if (!vals) return;
    const start = parseTime($('rigi-start').value);
    const end = parseTime($('rigi-end').value);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      toast('生效起止格式不正确，请输入秒数（如 90）或 mm:ss（如 01:30）', true);
      return;
    }
    if (start >= end) {
      toast('生效开始秒数必须小于结束秒数', true);
      return;
    }
    const leftPointId = $('rigi-left').value;
    const rightPointId = $('rigi-right').value;
    if (!leftPointId || !rightPointId) {
      toast('请选择左右吊点', true);
      return;
    }
    const id = $('rigi-id').value;
    const body = { name: $('rigi-name').value.trim(), ...vals, leftPointId, rightPointId, start, end };
    mutate(async () => {
      if (id) await api(`/api/rigItems/${id}`, 'PUT', body);
      else await api('/api/rigItems', 'POST', body);
      clearRigItemForm();
    }, id ? '吊挂件已更新，已重新核算' : '吊挂件已添加');
  });

  $('rigp-cancel').addEventListener('click', clearRigPointForm);
  $('rigi-cancel').addEventListener('click', clearRigItemForm);
}

/* ---------- 启动 ---------- */

(async function init() {
  bindForms();
  bindTableActions();
  bindHeaderActions();
  bindEvacuation();
  bindDependencies();
  bindCostume();
  bindImport();
  bindReplay();
  bindSightlineForms();
  bindSightMap();
  bindRigForms();
  setMode(state.mode);
  try {
    await refresh();
    refreshSelects();
  } catch (err) {
    toast('初始化失败：' + err.message, true);
  }
})();
