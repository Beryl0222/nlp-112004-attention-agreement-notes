// 配额台账：共享计时池按真实经过时间扣除，窗口重叠不扣两遍（同池时间并集）。
// 纪律：
//  - 待确认片段保留区间，不扣配额、不断言违规；
//  - 已消耗的一次性例外只消耗该次约定额度，不计入池；
//  - 补判只更正当前余额与后续许可，已显示的提醒原样保留，不回写；
//  - 依据错误余额发出的许可，事后复核标记为依据失效，后续活动不得沿用。

import { unionMinutes, splitByBoundary, intersect } from './time.mjs';

// 某片段是否由一次性例外覆盖（且例外仍在窗口内、用途相符）。
function coveredByException(seg, plan) {
  for (const c of plan.commitments) {
    if (c.kind !== 'exception') continue;
    if (!c.activityIds.includes(seg.activityId)) continue;
    // 例外只放行其声明用途；用途不符（如游戏放松）不得借道免扣。
    if (c.purpose && seg.purposes?.[0] && c.purpose !== seg.purposes[0]) continue;
    const overlap = intersect({ start: seg.start, end: seg.end }, c.window);
    if (!overlap) continue;
    if (c.onceOnly && c.spent) {
      // 已消耗的一次性例外：只放行其登记的那次片段。
      const own = c.spentSegments.some(s => s.segmentId === seg.segmentId);
      if (own) return { commitment: c, free: true };
      continue;
    }
    return { commitment: c, free: true };
  }
  return null;
}

// 计算每个池每个配额日的已扣分钟（并集），并登记一次性例外消耗。
export function computeLedger(result, plan, catalog) {
  const chargeable = []; // {poolId, interval, seg}
  const freeSegments = [];
  const heldSegments = [];
  const exceptionUsage = new Map();

  for (const seg of result.segments) {
    if (seg.status === 'pending') {
      heldSegments.push(seg);
      continue;
    }
    const purpose = seg.purposes[0];
    const poolId = catalog.poolOfPurpose(purpose);
    const ex = coveredByException(seg, plan);
    if (ex) {
      freeSegments.push({ seg, commitmentId: ex.commitment.commitmentId });
      const arr = exceptionUsage.get(ex.commitment.commitmentId) ?? [];
      arr.push(seg.segmentId);
      exceptionUsage.set(ex.commitment.commitmentId, arr);
      continue;
    }
    // 只有该活动是池成员、且用途映射到该池才扣时。
    if (poolId && catalog.poolById.get(poolId).memberActivity.includes(seg.activityId)) {
      chargeable.push({ poolId, interval: { start: seg.start, end: seg.end }, seg });
    } else if (poolId) {
      seg.basis.push(`用途映射到 ${catalog.poolById.get(poolId).label} 池，但该活动非池成员，不扣时`);
    }
  }

  const byPoolDay = new Map();
  for (const { poolId, interval, seg } of chargeable) {
    const pool = catalog.poolById.get(poolId);
    const parts = splitByBoundary(interval, pool.dayBoundary, seg.start.offsetMin);
    for (const part of parts) {
      const key = `${poolId}|${part.dayKey}`;
      const arr = byPoolDay.get(key) ?? [];
      arr.push({ interval: { start: part.start, end: part.end }, segmentId: seg.segmentId });
      byPoolDay.set(key, arr);
    }
  }

  const rows = [];
  for (const [key, items] of byPoolDay) {
    const [poolId, dayKey] = key.split('|');
    const pool = catalog.poolById.get(poolId);
    const used = unionMinutes(items.map(i => i.interval));
    rows.push({
      poolId,
      poolLabel: pool.label,
      dayKey,
      limitMinutes: pool.minutes,
      usedMinutes: used,
      remainingMinutes: pool.minutes - used,
      overMinutes: Math.max(0, used - pool.minutes),
      chargedSegments: [...new Set(items.map(i => i.segmentId))],
    });
  }

  // 一次性例外消耗登记（幂等）。
  for (const [commitmentId, segIds] of exceptionUsage) {
    const c = plan.commitments.find(x => x.commitmentId === commitmentId);
    if (c && c.onceOnly && !c.spent) {
      const first = result.segments.find(s => s.segmentId === segIds[0]);
      c.spent = true;
      c.spentSegments = segIds.map(id => ({ segmentId: id, start: result.segments.find(s => s.segmentId === id).start }));
      c.trace.push(`一次性额度已消耗于 ${segIds.join('、')}，之后申请不再放行`);
    }
  }

  return {
    rows: rows.sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.poolId.localeCompare(b.poolId)),
    heldSegments: heldSegments.map(s => s.segmentId),
    freeSegments,
    chargeableCount: chargeable.length,
  };
}

export function balanceAt(ledger, poolId, dayKey) {
  const row = ledger.rows.find(r => r.poolId === poolId && r.dayKey === dayKey);
  if (!row) {
    return { usedMinutes: 0, remainingMinutes: null, found: false };
  }
  return { found: true, usedMinutes: row.usedMinutes, remainingMinutes: row.remainingMinutes, overMinutes: row.overMinutes };
}

// 决策：某活动在某时刻还能否进行（基于补判后的当前余额，不沿用错误许可）。
export function permit(ledger, catalog, activityId, purpose, dayKey) {
  const poolId = catalog.poolOfPurpose(purpose);
  if (!poolId || !catalog.poolById.get(poolId).memberActivity.includes(activityId)) {
    return { permitted: true, reason: '该活动/用途不消耗任何池' };
  }
  const bal = balanceAt(ledger, poolId, dayKey);
  if (!bal.found) {
    const pool = catalog.poolById.get(poolId);
    return { permitted: true, poolLabel: pool.label, remainingMinutes: pool.minutes, reason: '当日尚无扣时' };
  }
  if (bal.remainingMinutes > 0) {
    return { permitted: true, poolLabel: catalog.poolById.get(poolId).label, remainingMinutes: bal.remainingMinutes, reason: '余额充足' };
  }
  return {
    permitted: false,
    poolLabel: catalog.poolById.get(poolId).label,
    remainingMinutes: bal.remainingMinutes,
    overMinutes: bal.overMinutes,
    reason: `配额已用尽（超 ${bal.overMinutes} 分钟），历史许可若基于错误余额，不再沿用`,
  };
}

// 对已显示提醒做事后复核：提醒记录原样保留，仅标注其当时余额依据如今是否成立。
export function reviewReminders(bundle, ledger, catalog, result, plan) {
  return bundle.reminders.map(r => {
    const entry = bundle.timeline.find(t => t.id === r.entry);
    const seg = result.segments.find(s => s.entryId === r.entry);
    const basisNotes = r.notes.map(id => bundle.notes.find(n => n.id === id)).filter(Boolean);
    const findings = [];
    let basisNowInvalid = false;

    // 找到该提醒活动经补判后的用途及对应池。
    const purpose = seg?.purposes?.[0] ?? null;
    const poolId = purpose ? catalog.poolOfPurpose(purpose) : null;
    const row = poolId ? ledger.rows.find(x => x.poolId === poolId) : null;

    if (/分钟|还可继续|可以继续/.test(r.display)) {
      if (row) {
        findings.push(`补判后 ${catalog.poolById.get(poolId).label} 池已扣 ${row.usedMinutes}/${row.limitMinutes} 分钟，余 ${row.remainingMinutes}`);
        // 余额提示或“可继续”许可：最终余额已耗尽/超支，即当时依据失效，后续不可沿用。
        if (row.remainingMinutes <= 0) basisNowInvalid = true;
      } else if (poolId) {
        findings.push(`该池当日无扣时记录`);
      }
    } else if (/等待确认|用途不清/.test(r.display)) {
      findings.push(seg?.status === 'pending' ? '该区间至今仍待确认，提醒与现状一致' : `该区间已补判为 ${purpose}，提醒作为历史记录保留`);
    }
    if (entry && seg?.violation) findings.push(`关联片段补判后认定违规：${seg.violation.reason}`);

    return {
      reminderId: r.id,
      shownAt: r.at,
      displayKept: r.display,
      entry: r.entry,
      basisNotes: basisNotes.map(n => ({ id: n.id, quote: n.utterance })),
      basisNowInvalid,
      findings,
      immutable: true,
      note: '提醒原样留存；basisNowInvalid 仅表示其当时余额依据经补判后失效，不修改历史显示',
    };
  });
}

export function renderLedger(ledger, catalog) {
  const lines = ['配额台账（同池窗口并集，重叠不重复扣）'];
  for (const row of ledger.rows) {
    lines.push(
      `  ${row.poolLabel} ${row.dayKey}：已扣 ${row.usedMinutes}/${row.limitMinutes} 分钟，余 ${row.remainingMinutes}${row.overMinutes ? `，超 ${row.overMinutes}` : ''}；片段 ${row.chargedSegments.join('、')}`,
    );
  }
  if (ledger.heldSegments.length) lines.push(`  待确认（不扣配额）：${ledger.heldSegments.join('、')}`);
  for (const f of ledger.freeSegments) lines.push(`  例外免扣：${f.seg.segmentId}（${f.commitmentId}）`);
  return lines.join('\n');
}
