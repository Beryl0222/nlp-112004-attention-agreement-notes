import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCatalog } from '../tools/lib/catalog.mjs';
import { interpretNotes } from '../tools/lib/interpreter.mjs';
import { createPlan, confirmProposals, evaluate, activeAt } from '../tools/lib/plan.mjs';
import { instant } from '../tools/lib/time.mjs';

const bundle = readBundle();
const catalog = buildCatalog(bundle);
const { proposals } = interpretNotes(bundle, catalog);
const byId = Object.fromEntries(proposals.map(p => [p.id, p]));

test('同伴的十点全锁只是报告，不成为本人的生效命令', () => {
  const report = proposals.find(p => p.noteId === 'n2');
  assert.equal(report.kind, 'report');
  assert.equal(report.adopted, false);
  // 本人笔记里对同一转述也只是“没说同意”。
  const reject = proposals.find(p => p.noteId === 'n3' && p.kind === 'report');
  assert.ok(reject);
  const plan = createPlan();
  const r = confirmProposals(plan, proposals, [report.id, reject.id]);
  assert.equal(r.confirmed.length, 0);
  assert.equal(plan.commitments.length, 0);
});

test('老师录屏例外带一次性额度与 19:00 结束条件', () => {
  const ex = proposals.find(p => p.noteId === 'n3' && p.kind === 'exception');
  assert.equal(ex.onceOnly, true);
  assert.equal(ex.endAnchor, '19:00');
  assert.deepEqual(ex.activityIds, ['v']);
  assert.ok(ex.trace.some(s => s.includes('p7')));
});

test('n7 的澄清回填 n6 含混限制：短休游戏、九点结束', () => {
  const ban = proposals.find(p => p.noteId === 'n6' && p.kind === 'restriction');
  assert.equal(ban.ambiguous, false);
  assert.deepEqual(ban.activityIds, ['g']);
  assert.equal(ban.endAnchor, '09:00');
  assert.ok(ban.ambiguityResolvedBy);
});

test('替代动作识别为 substitution 而不是例外，且指向随手看池', () => {
  const sub = proposals.find(p => p.noteId === 'n1' && p.kind === 'substitution');
  assert.equal(sub.poolLabel, '随手看');
  assert.equal(sub.prerequisite, '先走一圈');
});

test('确认后明确例外在自身范围内盖过一般限制', () => {
  const plan = createPlan();
  const ids = proposals.filter(p =>
    !p.ambiguous && !['report', 'rejection', 'clarification', 'unclassified'].includes(p.kind) && !p.modifiesOnly,
  ).map(p => p.id);
  confirmProposals(plan, proposals, ids);

  const restriction = plan.commitments.find(c => c.kind === 'restriction' && c.activityIds.includes('v'));
  const exception = plan.commitments.find(c => c.kind === 'exception');
  const during = instant('2026-11-20T18:45:00+08:00');
  assert.ok(activeAt(restriction, during));
  assert.ok(activeAt(exception, during));
  const v = evaluate(plan, 'v', '作业', during);
  assert.equal(v.verdict, 'allow');
  assert.ok(v.reason.includes('盖过'));
});

test('例外窗口结束后不再放行，老师指定也不延长', () => {
  const plan = createPlan();
  const ids = proposals.filter(p =>
    !p.ambiguous && !['report', 'rejection', 'clarification', 'unclassified'].includes(p.kind) && !p.modifiesOnly,
  ).map(p => p.id);
  confirmProposals(plan, proposals, ids);
  const after = instant('2026-11-20T19:30:00+08:00');
  const v = evaluate(plan, 'v', '作业', after);
  assert.equal(v.verdict, 'block');
});

test('多条约定冲突且无明确例外时返回 undecidable，交本人选择', () => {
  const plan = createPlan();
  // 构造两条同活动冲突约定：一条限制、一条锁闭，均无例外。
  plan.commitments.push({
    commitmentId: 'x1', proposalId: 'x1', noteId: 'n1', sourceQuote: '限制', kind: 'restriction',
    activityIds: ['m'], purpose: null, poolLabel: null,
    window: { start: instant('2026-11-20T18:00:00+08:00'), end: null },
    onceOnly: false, spent: false, spentSegments: [], trace: [],
  });
  plan.commitments.push({
    commitmentId: 'x2', proposalId: 'x2', noteId: 'n6', sourceQuote: '锁闭', kind: 'lock',
    activityIds: ['m'], purpose: null, poolLabel: null,
    window: { start: instant('2026-11-20T18:00:00+08:00'), end: null },
    onceOnly: false, spent: false, spentSegments: [], trace: [],
  });
  const r = evaluate(plan, 'm', null, instant('2026-11-20T18:30:00+08:00'));
  assert.equal(r.verdict, 'undecidable');
});

test('含混提案在澄清前不能确认', () => {
  const plan = createPlan();
  const ambiguous = proposals.filter(p => p.ambiguous);
  // 数据集经 n7 澄清后应无残留含混；构造一个含混提案验证守卫。
  const fake = { ...byId[proposals[0].id], id: 'pX', ambiguous: true, status: 'ambiguous', kind: 'restriction' };
  const r = confirmProposals(plan, [fake], ['pX']);
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.skipped[0].reason.includes('含混'));
});
