// 计划模块：已确认约定（commitments）与冲突裁决。
// 纪律：明确例外只在自身时间与活动范围内盖过一般限制；无法判明哪条适用时返回 undecidable，
// 由本人选择，当次不扣配额、不断言违规。

import { instant, wall, wallAtDate, isBefore, dateKey } from './time.mjs';

const NIGHT_START = '18:00'; // “晚作业/晚饭后”的演练约定起点
const DAY_START = '00:00';

function keyAtOffset(note, delta) {
  const w = wall(note);
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d) + delta * 86400000);
  return d.toISOString().slice(0, 10);
}

// 周一为一周起点；返回“这周”的最后一个挂钟日期（周日）。
function endOfWeekKey(note) {
  const w = wall(note);
  const dt = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  const dow = dt.getUTCDay(); // 0=周日
  const toSunday = dow === 0 ? 0 : 7 - dow;
  dt.setUTCDate(dt.getUTCDate() + toSunday);
  return dt.toISOString().slice(0, 10);
}

function atHHMM(key, hhmm, offsetMin) {
  const [h, mi] = hhmm.split(':').map(Number);
  return wallAtDate(key, `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, offsetMin);
}

function anchorToWindow(proposal, noteIso) {
  const note = instant(noteIso);
  const today = dateKey(note);
  const anchor = proposal.resolvedAnchor;

  // 明确结束条件（只到 HH:MM），结束时刻可能在手记次日（用澄清里的 offsetDays）。
  if (proposal.kind === 'exception' && proposal.endAnchor) {
    const offset = proposal.endOffsetDays ?? proposal.timeAnchor?.offsetDays ?? 0;
    const endKey = keyAtOffset(note, offset);
    // “今晚”类例外从当晚 18:00 起；其它情况从手记当日 00:00 起。
    const startHHMM = proposal.timeAnchor?.kind === 'night' ? NIGHT_START : DAY_START;
    const startKey = keyAtOffset(note, proposal.timeAnchor?.offsetDays ?? 0);
    return {
      start: atHHMM(startKey, startHHMM, note.offsetMin),
      end: atHHMM(endKey, proposal.endAnchor, note.offsetMin),
    };
  }

  if (anchor?.epoch) {
    const end = { epoch: anchor.epoch + 86400000, offsetMin: note.offsetMin, iso: new Date(anchor.epoch + 86400000).toISOString() };
    return { start: anchor, end };
  }
  if (anchor?.kind === 'night' || proposal.timeAnchor?.kind === 'night') {
    return { start: wallAtDate(today, NIGHT_START, note.offsetMin), end: wallAtDate(keyAtOffset(note, 1), DAY_START, note.offsetMin) };
  }
  if (anchor?.kind === 'nextDay') {
    const key = keyAtOffset(note, 1);
    return { start: wallAtDate(key, DAY_START, note.offsetMin), end: wallAtDate(keyAtOffset(note, 2), DAY_START, note.offsetMin) };
  }
  if (anchor?.kind === 'week') {
    return { start: wallAtDate(today, DAY_START, note.offsetMin), end: wallAtDate(endOfWeekKey(note), '23:59', note.offsetMin) };
  }
  // 无时间锚点的限制：按手记当日起生效，持续到本人修改。
  return { start: wallAtDate(today, DAY_START, note.offsetMin), end: null };
}

export function buildCommitment(proposal) {
  const win = anchorToWindow(proposal, proposal.noteAt);
  return {
    commitmentId: `c-${proposal.id}`,
    proposalId: proposal.id,
    noteId: proposal.noteId,
    sourceQuote: proposal.sourceQuote,
    kind: proposal.kind,
    activityIds: proposal.activityIds ?? [],
    purpose: proposal.purpose ?? null,
    poolLabel: proposal.poolLabel ?? null,
    window: win,
    onceOnly: Boolean(proposal.onceOnly),
    spent: false,
    spentSegments: [],
    lockScopeAll: /全部/.test(proposal.sourceQuote),
    trace: [...proposal.trace],
  };
}

export function createPlan() {
  return { commitments: [], decisions: [], overriddenBy: [] };
}

// 确认一批提案；报告、拒绝、未归类与含混提案不进入生效计划。
export function confirmProposals(plan, proposals, idsToConfirm) {
  const result = { confirmed: [], skipped: [] };
  const have = new Set(plan.commitments.map(c => c.proposalId));
  for (const id of idsToConfirm) {
    const p = proposals.find(x => x.id === id);
    if (!p) {
      result.skipped.push({ id, reason: '提案不存在' });
      continue;
    }
    if (have.has(id)) {
      result.skipped.push({ id, reason: '此前已确认' });
      continue;
    }
    if (p.kind === 'report' || p.kind === 'rejection' || p.kind === 'unclassified' || p.kind === 'clarification') {
      result.skipped.push({ id, reason: `${p.kind} 不构成生效约定` });
      continue;
    }
    if (p.ambiguous && p.status === 'ambiguous') {
      result.skipped.push({ id, reason: '仍含混，需先说明或改判' });
      continue;
    }
    if (p.modifiesOnly) {
      result.skipped.push({ id, reason: '仅对另一条例外补正结束条件，不单独生成约定' });
      continue;
    }
    plan.commitments.push(buildCommitment(p));
    result.confirmed.push(id);
  }
  return result;
}

export function activeAt(commitment, t) {
  const afterStart = !isBefore(t, commitment.window.start);
  const beforeEnd = commitment.window.end === null || isBefore(t, commitment.window.end);
  return afterStart && beforeEnd;
}

function appliesTo(commitment, activityId, purpose) {
  if (!commitment.activityIds.includes(activityId)) return false;
  if (commitment.purpose && purpose && commitment.purpose !== purpose) return false;
  return true;
}

// 在某时刻对某活动/用途返回适用约定与裁决。
// 返回 { verdict: allow|block|undecidable, restrictions, exceptions, reason }
export function evaluate(plan, activityId, purpose, t) {
  const active = plan.commitments.filter(c => activeAt(c, t) && appliesTo(c, activityId, purpose));
  const restrictions = active.filter(c => c.kind === 'restriction' || c.kind === 'lock');
  const exemptions = active.filter(c => c.kind === 'lockExemption' || c.kind === 'purposeDeclaration');
  const exceptions = active.filter(c => c.kind === 'exception' && !(c.onceOnly && c.spent));

  if (restrictions.length === 0) {
    return { verdict: 'allow', restrictions: [], exceptions, reason: '无适用限制' };
  }

  // 明确例外在自身范围内盖过一般限制。
  if (exceptions.length > 0) {
    return {
      verdict: 'allow',
      restrictions,
      exceptions,
      reason: `明确例外 ${exceptions.map(e => e.commitmentId).join('、')} 在自身范围内盖过限制`,
    };
  }

  // 锁闭豁免。
  if (exemptions.some(e => e.activityIds.includes(activityId))) {
    return { verdict: 'allow', restrictions, exceptions: [], reason: '存在针对该活动的锁闭豁免' };
  }

  // 多条限制互相冲突且无例外可判：交本人选，当次不扣配额、不断言违规。
  const kinds = new Set(restrictions.map(r => r.kind));
  if (restrictions.length > 1 && kinds.size > 1) {
    return { verdict: 'undecidable', restrictions, exceptions: [], reason: '多条约定冲突且无明确例外，需本人选择适用哪条' };
  }

  return { verdict: 'block', restrictions, exceptions: [], reason: `受 ${restrictions.map(r => r.commitmentId).join('、')} 限制` };
}

// 一次性例外的消耗登记：只登记落在例外窗口内、且确属该例外用途的片段。
export function consumeOnceOnly(plan, commitmentId, segment) {
  const c = plan.commitments.find(x => x.commitmentId === commitmentId);
  if (!c || c.kind !== 'exception') return false;
  if (!c.onceOnly || c.spent) return false;
  c.spent = true;
  c.spentSegments.push(segment);
  c.trace.push(`一次性额度于 ${segment.start.iso} 消耗，之后不再放行、不自动延期`);
  return true;
}

export function renderPlan(plan, catalog) {
  if (plan.commitments.length === 0) return '（尚无已确认约定）';
  const lines = [];
  for (const c of plan.commitments) {
    const win = c.window.end
      ? `${c.window.start.iso} → ${c.window.end.iso}`
      : `${c.window.start.iso} 起长期有效`;
    const tag = c.onceOnly ? `｜一次性${c.spent ? '（已消耗）' : '（未消耗）'}` : '';
    lines.push(
      `${c.commitmentId} [${c.kind}${tag}] ${c.activityIds.map(id => catalog.byId.get(id)?.application ?? id).join('、') || '?'}`,
    );
    lines.push(`  窗口：${win}`);
    lines.push(`  原句（${c.noteId}）：${c.sourceQuote}`);
  }
  return lines.join('\n');
}
