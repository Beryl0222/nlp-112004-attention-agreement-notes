import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCatalog } from '../tools/lib/catalog.mjs';
import { interpretNotes } from '../tools/lib/interpreter.mjs';
import { createPlan, confirmProposals } from '../tools/lib/plan.mjs';
import { adjudicate, applyPlanToSegments } from '../tools/lib/adjudication.mjs';
import { computeLedger, permit, reviewReminders, balanceAt } from '../tools/lib/ledger.mjs';
import { suggestOnceOnlyRewrite, explainContradictoryReminders, medicalGuard, traceReminder } from '../tools/lib/review.mjs';
import { adjudicateChoice, recompute } from '../tools/lib/assistant.mjs';
import { instant } from '../tools/lib/time.mjs';

function setup() {
  const bundle = readBundle();
  const catalog = buildCatalog(bundle);
  const { proposals } = interpretNotes(bundle, catalog);
  const plan = createPlan();
  const ids = proposals.filter(p =>
    !p.ambiguous && !['report', 'rejection', 'clarification', 'unclassified'].includes(p.kind) && !p.modifiesOnly,
  ).map(p => p.id);
  confirmProposals(plan, proposals, ids);
  const result = adjudicate(bundle, catalog);
  applyPlanToSegments(result, plan, catalog);
  const ledger = computeLedger(result, plan, catalog);
  return { bundle, catalog, plan, result, ledger };
}

test('补记把纸鸽窗切成等快递与随手看两段，用途各自归位', () => {
  const { result } = setup();
  const s1 = result.segments.find(s => s.segmentId === 't3-s1');
  const s2 = result.segments.find(s => s.segmentId === 't6-s2');
  assert.equal(s1.status, 'confirmed');
  assert.deepEqual(s1.purposes, ['等快递']);
  assert.deepEqual(s2.purposes, ['等快递']);
});

test('待确认片段保留区间且不扣配额、不断言违规', () => {
  const { result, ledger } = setup();
  // 数据中所有片段经补记/hint 均有归属；构造一个 pending 片段验证守卫。
  result.segments.push({
    segmentId: 'tx-s1', entryId: 'tx', activityId: 'p', window: '主窗',
    start: instant('2026-11-20T20:00:00+08:00'), end: instant('2026-11-20T20:05:00+08:00'),
    minutes: 5, hint: '活动目的不详。', clarificationBasis: [], purposes: ['作业', '随手看'],
    status: 'pending', basis: [], held: true, violation: null,
  });
  const before = ledger.rows.reduce((n, r) => n + r.usedMinutes, 0);
  const re = computeLedger(result, setup().plan, setup().catalog);
  const after = re.rows.reduce((n, r) => n + r.usedMinutes, 0);
  assert.ok(re.heldSegments.includes('tx-s1'));
  assert.equal(after, before);
});

test('随手看池按并集扣 28 分钟、超 8 分钟，重叠不扣两遍', () => {
  const { ledger } = setup();
  const row = ledger.rows.find(r => r.poolLabel === '随手看' && r.dayKey === '2026-11-20');
  assert.equal(row.usedMinutes, 28);
  assert.equal(row.remainingMinutes, -8);
  assert.equal(row.overMinutes, 8);
  // t2(3) 与 t3-s2(7) 在 18:55 相接；t3-s2 与 t5 重叠 0 分钟；t5 与 t6-s1 重叠 5 分钟只扣一次。
  // 3 + 7 + 18 + 5 - 5(重叠) = 28
});

test('一次性例外覆盖的卷页片段免扣，且例外标记为已消耗', () => {
  const { ledger, plan } = setup();
  const ex = plan.commitments.find(c => c.kind === 'exception');
  assert.equal(ex.spent, true);
  assert.ok(ledger.freeSegments.some(f => f.seg.segmentId === 't1-s1'));
  assert.ok(ledger.freeSegments.some(f => f.seg.segmentId === 't4-s1'));
  const k1 = ledger.rows.find(r => r.poolLabel === '随手看');
  assert.ok(!k1.chargedSegments.includes('t1-s1'));
});

test('例外过期后再申请不放行，老师指定不延长', () => {
  const { ledger, catalog, plan } = setup();
  // 19:30 的卷页“作业”用途：例外窗口已过，受限制阻挡。
  const p = permit(ledger, catalog, 'p', '随手看', '2026-11-20');
  assert.equal(p.permitted, false);
  assert.ok(p.reason.includes('不再沿用') || p.reason.includes('配额已用尽'));
});

test('跨 04:00 日界的短休被切到两个配额日', () => {
  const { result, ledger, catalog } = setup();
  const t7 = result.segments.find(s => s.entryId === 't7');
  assert.equal(t7.minutes, 8);
  const k2days = ledger.rows.filter(r => r.poolLabel === '短休');
  // hint-only 的放松片段会进短休池；验证两日各 4 分钟。
  const d20 = k2days.find(r => r.dayKey === '2026-11-20');
  const d21 = k2days.find(r => r.dayKey === '2026-11-21');
  assert.equal(d20.usedMinutes, 4);
  assert.equal(d21.usedMinutes, 4);
});

test('已显示提醒原样保留；错误余额许可被标注依据失效', () => {
  const { bundle, catalog, result, plan, ledger } = setup();
  const reviewed = reviewReminders(bundle, ledger, catalog, result, plan);
  const r2 = reviewed.find(r => r.reminderId === 'r2');
  const r3 = reviewed.find(r => r.reminderId === 'r3');
  assert.equal(r2.displayKept, '预估随手看还有 17 分钟。');
  assert.equal(r2.immutable, true);
  assert.equal(r2.basisNowInvalid, true);
  assert.equal(r3.basisNowInvalid, true);
  // 原始 reminders 资料未被改写。
  assert.equal(bundle.reminders.find(r => r.id === 'r2').display, '预估随手看还有 17 分钟。');
});

test('复盘能溯源提醒到具体手记与活动片段', () => {
  const { bundle, catalog, result, plan, ledger } = setup();
  const traced = traceReminder(bundle.reminders.find(r => r.id === 'r2'), bundle, result, plan, ledger);
  assert.equal(traced.activityBasis.entryId, 't5');
  assert.ok(traced.planBasis.some(b => b.noteId === 'n1'));
  const rep = explainContradictoryReminders(bundle, result, plan, ledger);
  assert.equal(rep.reminders.length, 2);
  assert.ok(rep.reconciliation.includes('pending'));
});

test('一次性改写建议需要本人确认，未确认不改计划', () => {
  const { bundle } = setup();
  const sug = suggestOnceOnlyRewrite(bundle);
  assert.equal(sug.requiresConfirmation, true);
  assert.ok(sug.candidateRewrite.includes('不延长'));
  assert.ok(sug.ambiguityInOriginal.length >= 2);
});

test('医学用语被拦截，助手不下医学判断', () => {
  const g = medicalGuard('我是不是手机成瘾，需要诊断和治疗？');
  assert.equal(g.blocked, true);
  assert.ok(g.message.includes('不'));
  assert.equal(medicalGuard('今晚先把作业写完'), null);
});

test('非池成员用途不消耗配额', () => {
  const { ledger } = setup();
  // 等快递不属于任何池标签，纸鸽等快递片段不应出现在随手看扣时片段里。
  const k1 = ledger.rows.find(r => r.poolLabel === '随手看');
  assert.ok(!k1.chargedSegments.includes('t3-s1'));
  assert.ok(!k1.chargedSegments.includes('t6-s2'));
});

test('本人补判 pending 片段后重算余额，历史提醒不回写', () => {
  const ctx = { bundle: readBundle(), catalog: buildCatalog(readBundle()) };
  const { proposals } = interpretNotes(ctx.bundle, ctx.catalog);
  const plan = createPlan();
  confirmProposals(plan, proposals, proposals.filter(p =>
    !p.ambiguous && !['report', 'rejection', 'clarification', 'unclassified'].includes(p.kind) && !p.modifiesOnly,
  ).map(p => p.id));
  const result = adjudicate(ctx.bundle, ctx.catalog);
  applyPlanToSegments(result, plan, ctx.catalog);
  const before = computeLedger(result, plan, ctx.catalog);

  // 人为制造一个 pending 片段，再由本人补判。
  const seg = {
    segmentId: 'tz-s1', entryId: 't5', activityId: 'p', window: '主窗',
    start: instant('2026-11-20T19:06:00+08:00'), end: instant('2026-11-20T19:10:00+08:00'),
    minutes: 4, hint: '用途不详。', clarificationBasis: [], purposes: ['作业', '随手看'],
    status: 'pending', basis: [], held: true, violation: null,
  };
  result.segments.push(seg);
  assert.ok(computeLedger(result, plan, ctx.catalog).heldSegments.includes('tz-s1'));

  assert.throws(() => adjudicateChoice(result, ctx.catalog, 'tz-s1', '不存在的用途'), /可选用途/);
  adjudicateChoice(result, ctx.catalog, 'tz-s1', '随手看');
  const after = recompute(ctx, plan, result);
  assert.ok(!after.heldSegments.includes('tz-s1'));
  const k1 = after.rows.find(r => r.poolLabel === '随手看');
  assert.ok(k1.chargedSegments.includes('tz-s1'));

  // 历史提醒显示原文不变，只是复核依据状态可更新。
  const reviewed = reviewReminders(ctx.bundle, after, ctx.catalog, result, plan);
  assert.equal(reviewed.find(r => r.reminderId === 'r3').displayKept, '当前还可继续。');
  assert.equal(before.rows.length, after.rows.length);
});
