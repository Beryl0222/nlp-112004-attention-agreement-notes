// 手记解释器：把自然语言手记拆成可确认的“约定提案”。
// 规则全部基于用户自己的活动目录；未登记或指代不明的词一律标记含混，交本人处理。
// 关键纪律：他人转述（“X 说/建议”）只形成报告，绝不变成本人的生效命令。

import { instant, wall, hm, dateKey } from './time.mjs';

// 用途同义词：只映射到用户目录中确实存在的用途。
const PURPOSE_SYNONYMS = {
  作业: '作业',
  做作业: '作业',
  写作业: '作业',
  课件: '作业',
  录屏: '作业',
  快递: '等快递',
  家人: '联系家人',
  推荐: '随手看',
  闲看: '随手看',
  刷推荐: '随手看',
  短休: '放松',
  游戏: '放松',
  查资料: '查资料',
};

// 活动词根：在应用名与别称之外，允许这些词根命中对应活动。
// 强词根只属于单一活动，避免“录屏”误命中课程页、“纸鸽”误命中视频等跨活动污染。
const ACTIVITY_ROOTS = {
  v: ['视频', '录屏', '拉片'],
  m: ['纸鸽', '群聊', '催件', '找人'],
  p: ['推荐', '课程页', '风筝页', '评论'],
  g: ['小游戏', '闯关', '沉屿'],
};
// 共享词根“游戏”只归短休活动 g。
const EXCLUSIVE_ROOTS = [
  { word: '视频', id: 'v' }, { word: '录屏', id: 'v' }, { word: '拉片', id: 'v' },
  { word: '纸鸽', id: 'm' }, { word: '群聊', id: 'm' }, { word: '催件', id: 'm' }, { word: '找人', id: 'm' },
  { word: '小游戏', id: 'g' }, { word: '游戏', id: 'g' }, { word: '闯关', id: 'g' }, { word: '沉屿', id: 'g' },
  { word: '推荐', id: 'p' }, { word: '课程页', id: 'p' }, { word: '风筝页', id: 'p' },
];

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const QUANTITY_RE = /(一次|一轮|今晚一次|完成这次|走完一圈|走一圈|一圈)/;

function splitClauses(utterance) {
  return utterance
    .split(/[。；;！!？?]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function findPurpose(text, catalog) {
  const known = new Set();
  for (const a of catalog.activities) for (const p of a.possiblePurposes) known.add(p);
  for (const [word, purpose] of Object.entries(PURPOSE_SYNONYMS)) {
    if (text.includes(word) && known.has(purpose)) return purpose;
  }
  return null;
}

function findPoolLabel(text, catalog) {
  return catalog.pools.find(p => text.includes(p.label))?.label ?? null;
}

function parseHHMM(raw) {
  const digit = raw.match(/(\d{1,2}):(\d{2})/);
  if (digit) return `${digit[1].padStart(2, '0')}:${digit[2]}`;
  const cn = raw.match(/(十[一二]?|[一二两三四五六七八九])\s*点/);
  if (cn) return `${String(CN_NUM[cn[1]]).padStart(2, '0')}:00`;
  return null;
}

// 相对时间锚点：返回 { kind, hhmm?, offsetDays, raw }，不能判明则 null。
function findTimeAnchor(text) {
  const dayWord = text.includes('明天') || text.includes('明日') || text.includes('明早');
  const offsetDays = dayWord ? 1 : 0;
  const hhmm = parseHHMM(text);
  if (hhmm) return { kind: 'clock', hhmm, offsetDays, raw: text.match(/(\d{1,2}:\d{2}|十[一二]?\s*点|[一二两三四五六七八九]\s*点|\d{1,2}\s*点)/)[0] };
  if (text.includes('今晚')) return { kind: 'night', offsetDays: 0, raw: '今晚' };
  if (dayWord) return { kind: 'nextDay', offsetDays: 1, raw: text.match(/明[早日天]/)[0] };
  if (text.includes('这周') || text.includes('本周')) return { kind: 'week', offsetDays: 0, raw: text.match(/这?周|本周/)[0] };
  return null;
}

function findQuantity(text) {
  const m = text.match(QUANTITY_RE);
  return m ? m[0] : null;
}

function findActivities(text, catalog) {
  const hits = new Set();
  // 强词根先判：命中即锁定单一活动，不做跨活动扩散。
  for (const { word, id } of EXCLUSIVE_ROOTS) {
    if (text.includes(word)) {
      hits.add(id);
      return [...hits];
    }
  }
  for (const a of catalog.activities) {
    const words = [a.application, ...a.aliases];
    if (words.some(w => text.includes(w))) hits.add(a.id);
  }
  return [...hits];
}

// 转述检测：句中出现明确第三方主体的“说/建议/要求”，且本人未在同句采纳。
// 本人自己的“说的是/指的是”是澄清，不算转述。
function detectReport(text, who) {
  if (/说的是|指的是|我的意思是/.test(text)) return null;
  const m = text.match(/((?:搭档|同伴|老师|同学|家人|朋友|他|她|对方))(说|建议|要求|让)(?![^，,。；]*(同意|采纳|就按|照做))/);
  if (!m) return null;
  const adopted = /(我同意|我采纳|就按|照办|同意了)/.test(text);
  return { speaker: who, reported: true, adopted, raw: m[0], note: adopted ? '' : '他人转述，本人未表示采纳，不成为生效命令' };
}

function baseProposal({ id, note, clause, kind }) {
  return {
    id,
    noteId: note.id,
    sourceQuote: clause,
    who: note.who,
    kind,
    status: 'proposed',
    ambiguous: false,
    ambiguityReasons: [],
    trace: [],
    respondsTo: note.respondsTo,
    modifiesOnly: false,
  };
}

function markAmbiguous(p, reason) {
  p.ambiguous = true;
  p.status = 'ambiguous';
  p.ambiguityReasons.push(reason);
  return p;
}

function interpretClause(clause, note, catalog, seq) {
  const id = `p${seq}`;
  const text = clause;

  // 1) 他人转述优先识别（含本人笔记里对他人的转述）。
  const report = note.who !== '本人' ? { speaker: note.who, reported: true, adopted: false, raw: text, note: '来源非本人，不成为本人的生效命令' } : detectReport(text, note.who);
  if (report) {
    return {
      ...baseProposal({ id, note, clause, kind: 'report' }),
      speaker: report.speaker,
      adopted: report.adopted,
      trace: [`转述内容：“${text}”`, report.note].filter(Boolean),
    };
  }

  // 2) 本人明确不采纳转述。
  if (/(没说同意|不同意|不采纳|先不按)/.test(text)) {
    return {
      ...baseProposal({ id, note, clause, kind: 'rejection' }),
      trace: [`本人拒绝采纳转述：“${text}”`, '该转述保持为报告，不生成限制'],
    };
  }

  const anchor = findTimeAnchor(text);
  const purpose = findPurpose(text, catalog);
  const poolLabel = findPoolLabel(text, catalog);
  const activityIds = findActivities(text, catalog);
  const quantity = findQuantity(text);

  // 3) 澄清类：指代说明、补正、回溯说明、只给时钟的补充。
  const isClarification =
    /说的是|指的是|我的意思是|不算新一轮|除了.*还|完成这次后|开课是|是\d{1,2}\s*点|是[一二两三四五六七八九十]+\s*点/.test(text);
  if (isClarification) {
    const p = baseProposal({ id, note, clause, kind: 'clarification' });
    p.timeAnchor = anchor;
    p.activityIds = activityIds;
    p.purpose = purpose;
    if (/只到\s*\d{1,2}:\d{2}/.test(text)) p.endAnchor = text.match(/只到\s*(\d{1,2}:\d{2})/)[1];
    p.trace.push(`识别为对前文的澄清/补正：“${text}”`);
    return p;
  }

  // 4) 替代动作类（先走一圈，再从池里拿时间）——先于例外判定。
  if (/(先走|先去|再从|再拿|走完)/.test(text)) {
    const p = baseProposal({ id, note, clause, kind: 'substitution' });
    p.prerequisite = text.match(/(先走一圈|走一圈|走完一圈)/)?.[0] ?? null;
    p.poolLabel = poolLabel;
    p.purpose = purpose;
    p.activityIds = activityIds;
    p.timeAnchor = anchor;
    p.trace.push(`识别为替代动作约定：“${text}”`);
    if (!poolLabel) markAmbiguous(p, '替代后从哪个池拿时间未指明');
    if (!p.prerequisite) markAmbiguous(p, '前置动作未识别');
    return p;
  }

  // 5) 锁闭 / 限制类。
  const isLock = /(锁|全锁)/.test(text) && !/不要锁|别锁/.test(text);
  const isBan = /(别开|不要开|先不看|少刷|不开)/.test(text);
  if (isLock || isBan) {
    const p = baseProposal({ id, note, clause, kind: isLock ? 'lock' : 'restriction' });
    p.activityIds = activityIds;
    p.purpose = purpose;
    p.timeAnchor = anchor;
    p.trace.push(`识别为${isLock ? '锁闭' : '限制'}约定：“${text}”`);
    if (activityIds.length === 0) markAmbiguous(p, '未匹配到目录中的活动，需要本人指明作用对象');
    if (activityIds.length > 1) markAmbiguous(p, `同句命中多个活动（${activityIds.join('、')}），需要本人选定`);
    if (!anchor) markAmbiguous(p, '未给出启用时刻或适用时段');
    if (isLock && text.includes('全部')) p.trace.push('“全部”作用范围仍以目录活动为限，未登记活动不臆断');
    return p;
  }

  // “不要锁纸鸽”这类对锁闭的豁免。
  if (/不要锁|别锁/.test(text)) {
    const p = baseProposal({ id, note, clause, kind: 'lockExemption' });
    p.activityIds = activityIds;
    p.timeAnchor = anchor;
    p.trace.push(`识别为锁闭豁免：“${text}”`);
    if (activityIds.length === 0) markAmbiguous(p, '豁免未指明活动');
    return p;
  }

  // 6) 例外放行类（老师给的录屏、一次性许可、只到某时刻）。
  if (/(就算|看完.*算|例外|放行|允许|可以看|只到)/.test(text) || (purpose && quantity)) {
    const p = baseProposal({ id, note, clause, kind: 'exception' });
    p.activityIds = activityIds;
    p.purpose = purpose;
    p.timeAnchor = anchor;
    p.quantity = quantity;
    p.endAnchor = /只到\s*(\d{1,2}:\d{2})/.test(text) ? text.match(/只到\s*(\d{1,2}:\d{2})/)[1] : null;
    p.onceOnly = /一次|完成这次|看完一次/.test(text);
    p.trace.push(`识别为短期例外放行：“${text}”`);
    if (activityIds.length === 0) markAmbiguous(p, '例外未指明作用活动');
    if (!anchor && !p.endAnchor) markAmbiguous(p, '例外未给出启用或结束条件');
    if (p.onceOnly) p.trace.push(`一次性额度：${p.quantity ?? '一次'}，完成即止，不自动延期`);
    return p;
  }

  // 7) 用途声明（等快递时看纸鸽、只看快递不算随手）。
  if (/(不算|只看|只用于|用途是|等快递时|时也得看|时得看)/.test(text)) {
    const p = baseProposal({ id, note, clause, kind: 'purposeDeclaration' });
    p.activityIds = activityIds;
    p.purpose = purpose;
    p.timeAnchor = anchor;
    p.trace.push(`识别为用途声明：“${text}”`);
    if (activityIds.length === 0) markAmbiguous(p, '用途声明未指明活动');
    if (!purpose) markAmbiguous(p, '声明的用途不在目录 possiblePurposes 中');
    return p;
  }

  // 8) 无法归类。
  const p = baseProposal({ id, note, clause, kind: 'unclassified' });
  markAmbiguous(p, `规则无法可靠归类：“${text}”，保留原句待本人说明`);
  return p;
}

// 把时钟锚点解析成具体演练时刻（依赖手记自身日期与偏移）。
function resolveAnchor(anchor, noteIso) {
  if (!anchor) return null;
  const note = instant(noteIso);
  const w = wall(note);
  const keyAt = delta => {
    const d = new Date(Date.UTC(w.y, w.mo - 1, w.d) + delta * 86400000);
    return d.toISOString().slice(0, 10);
  };
  if (anchor.kind === 'clock') {
    const key = keyAt(anchor.offsetDays);
    const [h, mi] = anchor.hhmm.split(':').map(Number);
    const epoch = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)), h, mi) - note.offsetMin * 60000;
    return { epoch, offsetMin: note.offsetMin, iso: new Date(epoch).toISOString() };
  }
  return { relative: anchor.raw, kind: anchor.kind, offsetDays: anchor.offsetDays, offsetMin: note.offsetMin, noteDate: dateKey(note) };
}

export function interpretNotes(bundle, catalog) {
  const proposals = [];
  let seq = 0;
  const notes = [...bundle.notes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  for (const note of notes) {
    for (const clause of splitClauses(note.utterance)) {
      seq += 1;
      const p = interpretClause(clause, note, catalog, seq);
      if (p.timeAnchor) p.resolvedAnchor = resolveAnchor(p.timeAnchor, note.at);
      p.noteAt = note.at;
      proposals.push(p);
    }
  }

  const byNote = new Map();
  for (const p of proposals) {
    if (!byNote.has(p.noteId)) byNote.set(p.noteId, []);
    byNote.get(p.noteId).push(p);
  }

  // 澄清/补正沿 respondsTo 挂到目标提案，只回填缺失项，不覆盖已清楚的内容。
  for (const p of proposals) {
    if (p.kind !== 'clarification' || !p.respondsTo) continue;
    const targets = byNote.get(p.respondsTo) ?? [];
    p.targets = targets.map(t => t.id);
    for (const t of targets) {
      t.clarifiedBy = [...(t.clarifiedBy ?? []), p.id];
      if (p.activityIds.length && t.activityIds.length === 0) t.activityIds = [...p.activityIds];
      if (p.endAnchor && !t.endAnchor) {
        t.endAnchor = p.endAnchor;
        t.endFromProposal = p.id;
      }
      if (p.timeAnchor?.kind === 'clock' && !t.endAnchor) {
        t.endAnchor = p.timeAnchor.hhmm;
        t.endFromProposal = p.id;
        t.endOffsetDays = p.timeAnchor.offsetDays;
      }
      if (t.ambiguous) {
        const stillMissingActivity = t.kind !== 'substitution' && t.activityIds.length === 0;
        const stillMissingTime = !t.timeAnchor && !t.endAnchor;
        if (!stillMissingActivity && !stillMissingTime) {
          t.ambiguous = false;
          t.status = 'proposed';
          t.ambiguityResolvedBy = p.id;
          t.ambiguityReasons = [];
          t.trace.push(`含混点已由 ${p.id}（手记 ${p.noteId}）澄清`);
        }
      }
    }
  }

  // 例外的结束条件合并：只起补正作用的例外提案标记为 modifiesOnly，不重复生成约定。
  for (const p of proposals) {
    if (p.kind !== 'exception' || !p.respondsTo) continue;
    const targets = byNote.get(p.respondsTo) ?? [];
    for (const t of targets) {
      if (t.kind !== 'exception') continue;
      if (p.endAnchor) {
        t.endAnchor = p.endAnchor;
        t.endFromProposal = p.id;
        t.trace.push(`结束条件由 ${p.id} 限定为 ${p.endAnchor}`);
      }
      if (p.onceOnly) t.onceOnly = true;
      if (/只到/.test(p.sourceQuote)) p.modifiesOnly = true;
    }
  }

  return { proposals, generatedAt: notes.at(-1)?.at ?? null };
}

// 人看的解释视图：每条提案对原计划的变化、依据原句、含混点。
export function renderProposal(p, catalog) {
  const kindLabel = {
    restriction: '限制', lock: '锁闭', lockExemption: '锁闭豁免', exception: '短期例外',
    substitution: '替代动作', purposeDeclaration: '用途声明', clarification: '澄清/补正',
    report: '他人转述（报告）', rejection: '拒绝采纳', unclassified: '未归类',
  }[p.kind];
  const lines = [];
  lines.push(`【${p.id}｜${kindLabel}｜${p.ambiguous ? '含混待确认' : '可确认'}】来源手记 ${p.noteId}（${p.who}）`);
  lines.push(`  原句：${p.sourceQuote}`);
  if (p.activityIds?.length) lines.push(`  作用活动：${p.activityIds.map(id => catalog.byId.get(id)?.application ?? id).join('、')}`);
  if (p.purpose) lines.push(`  目的：${p.purpose}`);
  if (p.timeAnchor) lines.push(`  时间：${p.timeAnchor.raw}${p.resolvedAnchor?.epoch ? `（演练时刻 ${hm(p.resolvedAnchor)}）` : p.resolvedAnchor?.relative ? `（相对：${p.resolvedAnchor.relative}）` : ''}`);
  if (p.endAnchor) lines.push(`  结束条件：${p.endAnchor}${p.endFromProposal ? `（来自 ${p.endFromProposal}）` : ''}`);
  if (p.onceOnly) lines.push('  额度：一次性，完成即止');
  if (p.poolLabel) lines.push(`  计费池：${p.poolLabel}`);
  for (const tr of p.trace) lines.push(`  · ${tr}`);
  if (p.ambiguous) for (const r of p.ambiguityReasons) lines.push(`  · 含混：${r}`);
  return lines.join('\n');
}
