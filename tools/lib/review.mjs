// 复盘：解释提醒依据、给出由本人确认的改写建议；不做任何医学判断。

const MEDICAL_TERMS = ['诊断', '病症', '成瘾', '抑郁', '焦虑症', '多动症', 'ADHD', '病态', '治疗', '处方'];

export function medicalGuard(text) {
  const hit = MEDICAL_TERMS.filter(w => text.includes(w));
  if (hit.length === 0) return null;
  return {
    blocked: true,
    hit,
    message: '本助手只管理本人写下的使用意图与时间配额，不就笔记文字作任何医学判断或诊断；相关话题请咨询合格专业人士。',
  };
}

// 每条已显示提醒依据哪句计划、哪段活动。
export function traceReminder(reminder, bundle, result, plan, ledger) {
  const entry = bundle.timeline.find(t => t.id === reminder.entry);
  const segments = result.segments.filter(s => s.entryId === reminder.entry);
  const noteBasis = reminder.notes.map(id => {
    const n = bundle.notes.find(x => x.id === id);
    const commitment = plan.commitments.find(c => c.noteId === id);
    return {
      noteId: id,
      quote: n?.utterance ?? null,
      commitmentId: commitment?.commitmentId ?? null,
      role: commitment ? `已确认约定（${commitment.kind}）` : '未形成生效约定（转述/未确认/含混）',
    };
  });
  return {
    reminderId: reminder.id,
    shownAt: reminder.at,
    display: reminder.display,
    activityBasis: entry ? {
      entryId: entry.id,
      application: entry.activity,
      window: entry.window,
      range: `${entry.start} → ${entry.end}`,
      hint: entry.hint,
      segments: segments.map(s => ({
        segmentId: s.segmentId,
        status: s.status,
        purposes: s.purposes,
        held: s.held,
        violation: s.violation?.reason ?? null,
      })),
    } : null,
    planBasis: noteBasis,
  };
}

// “怎样写才能让‘把老师视频看完’只发生一次”：生成候选改写，必须本人确认。
export function suggestOnceOnlyRewrite(bundle) {
  const original = bundle.notes.find(n => /录屏今晚看完一次就算/.test(n.utterance));
  const end = bundle.notes.find(n => /只到 19:00/.test(n.utterance));
  return {
    question: '怎样写才能让“把老师视频看完”只发生一次？',
    original: original ? { noteId: original.id, quote: original.utterance } : null,
    ambiguityInOriginal: [
      '“今晚”跨度到次日 04:00 日界前，未给硬结束时刻；',
      '“一次”未定义是一次播放会话还是累计到某分钟；',
      '中途切到推荐区再切回，是否算新一轮没有写明。',
    ],
    candidateRewrite:
      '老师指定录屏（卷页/录屏）仅允许一次连续观看，目的限“作业”，有效窗口为当日 18:00–19:00；' +
      '窗口结束或视频结束帧出现即额度用尽，中途切到推荐区的时间按“随手看”另计，切回不开启新额度；' +
      '到期后即使标注“老师指定”也不延长，需本人另写新例外并确认。',
    hardEnd: end ? { noteId: end.id, quote: end.utterance } : null,
    requiresConfirmation: true,
    note: '改写只是建议，未确认前不改动已生效计划。',
  };
}

// 解释昨晚两条看似矛盾的提醒分别依据哪句计划、哪段活动。
export function explainContradictoryReminders(bundle, result, plan, ledger) {
  const r2 = bundle.reminders.find(r => /17 分钟/.test(r.display));
  const r3 = bundle.reminders.find(r => /还可继续/.test(r.display));
  const explain = r => {
    const traced = traceReminder(r, bundle, result, plan, ledger);
    const extra = [];
    if (r.id === 'r2') {
      extra.push('r2 时刻（19:08）只有 t2 推荐区 3 分钟已可确定扣时；t3/t6 纸鸽窗用途当时 pending，按规则不扣，故显示余 17 分钟。');
    }
    if (r.id === 'r3') {
      extra.push('r3 时刻（19:22）t5 仍在进行且部分用途待确认，系统按当时已确认余额显示“还可继续”。');
      extra.push('补判后纸鸽闲看区间纳入并集，随手看池实际超支，r3 的余额依据失效；提醒原样保留，后续同池活动不得沿用该许可。');
    }
    return { ...traced, explanation: extra };
  };
  return {
    question: '昨晚两条看似矛盾的提醒分别依据哪句计划、哪段活动？',
    reminders: [r2, r3].filter(Boolean).map(explain),
    reconciliation: '两者在各自显示时刻都符合“pending 不扣、仅按已确认余额提示”的规则；矛盾来自补判改变了已确认用途与并集扣时，而非规则被违反。历史提醒不可回写，只可标注依据失效。',
  };
}

export function renderReview(obj) {
  return JSON.stringify(obj, null, 2);
}
