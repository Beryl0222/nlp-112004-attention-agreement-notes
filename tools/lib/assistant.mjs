// 助手门面：把资料包、解释、确认、判读、台账、复盘串成一条可演练的流水线。
// 纯函数为主，状态（确认结果）由调用方传入，便于测试与回放。

import { readBundle } from '../materials.mjs';
import { buildCatalog } from './catalog.mjs';
import { interpretNotes, renderProposal } from './interpreter.mjs';
import { createPlan, confirmProposals, renderPlan, evaluate } from './plan.mjs';
import { adjudicate, applyPlanToSegments, renderAdjudication } from './adjudication.mjs';
import { computeLedger, permit, reviewReminders, renderLedger, balanceAt } from './ledger.mjs';import { traceReminder, suggestOnceOnlyRewrite, explainContradictoryReminders, medicalGuard } from './review.mjs';
import { instant, dateKey } from './time.mjs';

export function loadContext(directory) {
  const bundle = readBundle(directory);
  const catalog = buildCatalog(bundle);
  return { bundle, catalog };
}

export function explain({ bundle, catalog }) {
  return interpretNotes(bundle, catalog);
}

// 依据已保存的确认状态构建生效计划。
export function buildPlan({ bundle, catalog }, state) {
  const { proposals } = interpretNotes(bundle, catalog);
  const plan = createPlan();
  const ids = state.confirmedProposalIds ?? [];
  const result = confirmProposals(plan, proposals, ids);
  return { plan, proposals, confirmResult: result };
}

// 让本人对一个含混提案说明含义后再确认（记录选择，不自动替用户决定）。
export function resolveAmbiguity(state, proposalId, choice) {
  state.userChoices.push({ proposalId, choice, at: choice.at });
  if (choice.confirm) state.confirmedProposalIds.push(proposalId);
  return state;
}

// 本人对 pending 片段补判用途：只接受该活动 possiblePurposes 内的用途。
// 补判后重新判读与扣时；已显示提醒不回写，只在事后复核里改依据状态。
export function adjudicateChoice(result, catalog, segmentId, purpose, decidedBy = '本人') {
  const seg = result.segments.find(s => s.segmentId === segmentId);
  if (!seg) throw new Error(`片段不存在：${segmentId}`);
  const possible = catalog.byId.get(seg.activityId).possiblePurposes;
  if (!possible.includes(purpose)) {
    throw new Error(`用途“${purpose}”不在活动 ${seg.activityId} 的可选用途 ${possible.join('、')} 内`);
  }
  seg.purposes = [purpose];
  seg.status = 'confirmed';
  seg.held = false;
  seg.userDecided = { by: decidedBy, purpose, at: seg.end.iso };
  seg.basis.push(`本人补判用途为“${purpose}”，区间保留信息不变，按此重算余额`);
  return seg;
}

// 重算：补判后用同一计划重新套用并重建台账。
export function recompute({ bundle, catalog }, plan, result) {
  applyPlanToSegments(result, plan, catalog);
  return computeLedger(result, plan, catalog);
}

export function runAdjudication({ bundle, catalog }, plan) {
  const result = adjudicate(bundle, catalog);
  applyPlanToSegments(result, plan, catalog);
  const ledger = computeLedger(result, plan, catalog);
  return { result, ledger };
}

export function currentBalance(ledger, catalog, poolId, dayKey) {
  return balanceAt(ledger, poolId, dayKey);
}

export function canDo(ledger, catalog, activityId, purpose, dayKey) {
  return permit(ledger, catalog, activityId, purpose, dayKey);
}

export function replayReminders({ bundle, catalog }, result, plan, ledger) {
  return reviewReminders(bundle, ledger, catalog, result, plan);
}

export function review({ bundle, catalog }, result, plan, ledger) {
  return {
    onceOnlyRewrite: suggestOnceOnlyRewrite(bundle),
    contradictory: explainContradictoryReminders(bundle, result, plan, ledger),
    reminders: bundle.reminders.map(r => traceReminder(r, bundle, result, plan, ledger)),
  };
}

export {
  renderProposal,
  renderPlan,
  renderAdjudication,
  renderLedger,
  medicalGuard,
  evaluate,
  instant,
  dateKey,
};
