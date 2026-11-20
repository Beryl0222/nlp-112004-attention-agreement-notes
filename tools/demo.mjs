#!/usr/bin/env node
// 本地助手演示入口：只读 data/ 里的演练资料，确认结果写入 state/（本机）。
// 用法：node tools/demo.mjs [explain|plan|adjudicate|ledger|reminders|review|all]

import { loadContext, explain, buildPlan, runAdjudication, replayReminders, review, renderProposal, renderPlan, renderAdjudication, renderLedger, medicalGuard } from './lib/assistant.mjs';
import { loadState, saveState, defaultStatePath } from './lib/state.mjs';

const section = process.argv[2] ?? 'all';
const ctx = loadContext();
const state = loadState();

function heading(t) {
  console.log(`\n========== ${t} ==========`);
}

// 演示用确认清单：只确认清楚且属本人的约定；他人转述与含混项排除。
const DEMO_CONFIRM = [
  // 由解释阶段的提案 id 在运行时按类型挑选，避免硬编码序号。
];

const { proposals } = explain(ctx);
const confirmable = proposals.filter(p =>
  !p.ambiguous && !['report', 'rejection', 'clarification', 'unclassified'].includes(p.kind),
);
for (const p of confirmable) {
  if (!state.confirmedProposalIds.includes(p.id)) state.confirmedProposalIds.push(p.id);
}

const { plan } = buildPlan(ctx, state);
const { result, ledger } = runAdjudication(ctx, plan);

if (['explain', 'all'].includes(section)) {
  heading('一、手记解释（谁提出、何时启用、目的、活动、结束条件、含混点）');
  for (const p of proposals) console.log(renderProposal(p, ctx.catalog));
}

if (['plan', 'all'].includes(section)) {
  heading('二、已确认计划（他人转述不生效；含混项不进入）');
  console.log(renderPlan(plan, ctx.catalog));
  const report = proposals.find(p => p.kind === 'report');
  if (report) console.log(`\n未生效：${report.id} 为“${report.speaker}”的转述（${report.sourceQuote}），本人未采纳。`);
}

if (['adjudicate', 'all'].includes(section)) {
  heading('三、用途判读（多用途区间 pending，保留不扣）');
  console.log(renderAdjudication(result, ctx.catalog));
}

if (['ledger', 'all'].includes(section)) {
  heading('四、配额台账（并集扣时、日界切分、例外免扣）');
  console.log(renderLedger(ledger, ctx.catalog));
}

if (['reminders', 'all'].includes(section)) {
  heading('五、已显示提醒事后复核（原样保留，标注依据是否失效）');
  for (const r of replayReminders(ctx, result, plan, ledger)) {
    console.log(`${r.reminderId} @${r.shownAt} 显示原文：“${r.displayKept}”`);
    for (const f of r.findings) console.log(`  · ${f}`);
    console.log(`  · 依据如今${r.basisNowInvalid ? '失效（错误余额许可，后续不可沿用）' : '仍成立'}`);
  }
}

if (['review', 'all'].includes(section)) {
  heading('六、复盘问答');
  const rep = review(ctx, result, plan, ledger);
  console.log('问：' + rep.onceOnlyRewrite.question);
  console.log('原句问题：');
  for (const a of rep.onceOnlyRewrite.ambiguityInOriginal) console.log('  - ' + a);
  console.log('建议改写（需本人确认才生效）：' + rep.onceOnlyRewrite.candidateRewrite);
  console.log('\n问：' + rep.contradictory.question);
  for (const r of rep.contradictory.reminders) {
    console.log(`  ${r.reminderId}：${r.display}`);
    for (const e of r.explanation) console.log('    · ' + e);
  }
  console.log('\n对账：' + rep.contradictory.reconciliation);

  heading('七、边界：不做医学判断');
  const guard = medicalGuard('我是不是刷手机成瘾了，需要诊断吗？');
  console.log(guard.message);
}

saveState(state, defaultStatePath(), proposals.at(-1)?.noteAt ?? null);
if (section === 'all') console.log(`\n确认状态已保存在本机：${defaultStatePath()}（data/ 资料包未改动）`);
