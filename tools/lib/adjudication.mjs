// 用途判读：把计时器窗口事实与用户补记切成带用途的片段。
// 纪律：
//  - 一个片段有多种合理用途且用途影响扣时/替代提示 → pending，保留区间日后补判，当次不扣配额；
//  - 用户后补“老师指定”不会复活或延长已过期的一次性例外；
//  - 计时器 hint 原样保留，只作线索，不代表确认用途。

import { instant, hm, minutesBetween } from './time.mjs';

function parseClockFromText(text, baseIso) {
  const base = instant(baseIso);
  const m = text.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(base.epoch + base.offsetMin * 60000);
  const epoch = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2])) - base.offsetMin * 60000;
  return { epoch, offsetMin: base.offsetMin, iso: new Date(epoch).toISOString() };
}

// hint 线索词 → 用途（仅用于 hint-only 推断，绝不等于用户确认）。
const HINT_PURPOSE_WORDS = [
  { words: ['推荐', '闲', '随手'], purpose: '随手看' },
  { words: ['小游戏', '短休', '闯关'], purpose: '放松' },
  { words: ['作业', '课件', '课程'], purpose: '作业' },
  { words: ['快递'], purpose: '等快递' },
  { words: ['家人'], purpose: '联系家人' },
  { words: ['查资料', '资料'], purpose: '查资料' },
];

// 补记里的用途词 → 用途。
const CLAR_PURPOSE_WORDS = [
  { words: ['闲看', '随手', '群里转', '刷'], purpose: '随手看' },
  { words: ['等快递', '查快递', '快递更新', '快递'], purpose: '等快递' },
  { words: ['家人'], purpose: '联系家人' },
  { words: ['作业', '课还在听', '写作业', '录屏', '课'], purpose: '作业' },
  { words: ['小游戏', '短休', '游戏'], purpose: '放松' },
  { words: ['查资料'], purpose: '查资料' },
];

function purposesInText(text, possiblePurposes, table) {
  const hits = new Set();
  for (const { words, purpose } of table) {
    if (!possiblePurposes.includes(purpose)) continue;
    if (words.some(w => text.includes(w))) hits.add(purpose);
  }
  return [...hits];
}

// 从补记抽取窗口内的切点。
function extractCutPoints(text, windowStart, windowEnd) {
  const points = [];
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})/g)) {
    const t = parseClockFromText(m[0], windowStart.iso);
    if (t.epoch > windowStart.epoch && t.epoch < windowEnd.epoch && !points.some(p => p.at.epoch === t.epoch)) {
      points.push({ at: t, raw: m[0], sourceText: text });
    }
  }
  return points;
}

function splitEntry(entry, catalog, clarifications) {
  const win = { start: instant(entry.start), end: instant(entry.end) };
  const relevant = clarifications.filter(c => c.entry === entry.id);
  const cuts = [{ at: win.start, raw: '窗口起点', sourceText: null }];
  for (const c of relevant) {
    for (const pt of extractCutPoints(c.text, win.start, win.end)) cuts.push({ ...pt, sourceText: c.text, clarId: c.id });
  }
  cuts.sort((a, b) => a.at.epoch - b.at.epoch);
  cuts.push({ at: win.end, raw: '窗口终点', sourceText: null });

  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    if (cuts[i].at.epoch >= cuts[i + 1].at.epoch) continue;
    segments.push({
      segmentId: `${entry.id}-s${i + 1}`,
      entryId: entry.id,
      activityId: entry.activity,
      window: entry.window,
      start: cuts[i].at,
      end: cuts[i + 1].at,
      minutes: minutesBetween(cuts[i].at, cuts[i + 1].at),
      hint: entry.hint,
      clarificationBasis: [],
      purposes: [],
      status: 'pending',
      basis: [],
      cutAfter: cuts[i].sourceText ? { clarId: cuts[i].clarId, raw: cuts[i].raw, text: cuts[i].sourceText } : null,
    });
  }
  return segments;
}

// 补记是否声明该时刻边界“之前/之后”的用途，用于把用途归到正确的一侧。
function purposeForSegmentFromClarification(seg, clar, entry, catalog) {
  const possible = catalog.byId.get(seg.activityId).possiblePurposes;
  const text = clar.text;
  const purposes = purposesInText(text, possible, CLAR_PURPOSE_WORDS);
  if (purposes.length === 0) return [];
  const clocks = [...text.matchAll(/(\d{1,2}):(\d{2})/g)].map(m => parseClockFromText(m[0], entry.start));
  const segStart = seg.start.epoch;
  const segEnd = seg.end.epoch;

  // “直到 HH:MM 都在 A，后来 B”：切点之前 A，之后 B。
  const until = text.match(/直到\s*(\d{1,2}:\d{2})/);
  if (until) {
    const cut = parseClockFromText(until[1], entry.start);
    const before = purposesInText(text.match(/直到[^，,。；]*?(都在|在)([^，,。；]+)/)?.[2] ?? text, possible, CLAR_PURPOSE_WORDS);
    const after = purposesInText(text.split(/后来|之后|然后/).slice(1).join(' '), possible, CLAR_PURPOSE_WORDS);
    if (segEnd <= cut.epoch) return before;
    if (segStart >= cut.epoch) return after.length ? after : purposes;
  }

  // “HH:MM 到 HH:MM 做 A，前面都在 B”：只把对应用途归到对应一侧，互不串味。
  const range = text.match(/(\d{1,2}:\d{2})\s*到\s*(\d{1,2}:\d{2})/);
  if (range && clocks.length >= 2) {
    const rs = parseClockFromText(range[1], entry.start);
    const re = parseClockFromText(range[2], entry.start);
    // 区间子句在第一个逗号/句号处结束，避免把“前面都在…”的用途带进后段。
    const tailRaw = text.slice(text.indexOf(range[0]) + range[0].length);
    const tail = tailRaw.split(/[，,。；;]/)[0];
    const headText = text.split(/前面|之前/).slice(1).join(' ');
    const rangePurposes = purposesInText(tail, possible, CLAR_PURPOSE_WORDS);
    const frontPurposes = purposesInText(headText, possible, CLAR_PURPOSE_WORDS);
    if (segStart >= rs.epoch && segEnd <= re.epoch) {
      // 后段只认区间子句本身的用途，整句用途（含“前面闲看”）不得带入。
      return rangePurposes;
    }
    if (segEnd <= rs.epoch) {
      return frontPurposes.length ? frontPurposes : [];
    }
    return rangePurposes;
  }

  // 无明确边界词但整窗只有一条补记：直接适用。
  return purposes;
}

function adjudicateSegment(seg, entry, clarifications, catalog) {
  const possible = catalog.byId.get(seg.activityId).possiblePurposes;
  const covering = clarifications.filter(c => c.entry === entry.id);

  // 1) 补记判读。
  const clarHits = new Set();
  for (const c of covering) {
    const ps = purposeForSegmentFromClarification(seg, c, entry, catalog);
    for (const p of ps) {
      clarHits.add(p);
      if (!seg.clarificationBasis.includes(c.id)) seg.clarificationBasis.push(c.id);
      seg.basis.push(`补记 ${c.id}：“${c.text}” → ${p}`);
    }
  }
  if (clarHits.size === 1) {
    seg.purposes = [...clarHits];
    seg.status = 'confirmed';
    return seg;
  }
  if (clarHits.size > 1) {
    seg.purposes = [...clarHits];
    seg.status = 'pending';
    seg.basis.push('同一区间存在多个合理用途，保留区间待本人补判，当次不扣配额');
    return seg;
  }

  // 2) hint 线索（非确认）。
  const hintHits = purposesInText(seg.hint, possible, HINT_PURPOSE_WORDS);
  if (hintHits.length === 1 && !/不详|不知道|不确定/.test(seg.hint)) {
    seg.purposes = hintHits;
    seg.status = 'hint-only';
    seg.basis.push(`仅由计时器 hint 推断（非确认）：“${seg.hint}” → ${hintHits[0]}`);
    return seg;
  }
  if (hintHits.length > 1 && !/不详|不知道|不确定/.test(seg.hint)) {
    seg.purposes = hintHits;
    seg.status = 'pending';
    seg.basis.push(`hint 命中多个合理用途 ${hintHits.join('、')}，待本人确认`);
    return seg;
  }

  // 3) 目的不详：pending。
  seg.purposes = possible;
  seg.status = 'pending';
  seg.basis.push(`用途不详（hint：“${seg.hint}”），可选用途 ${possible.join('、')}，待本人确认`);
  return seg;
}

export function adjudicate(bundle, catalog) {
  const segments = [];
  for (const entry of bundle.timeline) {
    const parts = splitEntry(entry, catalog, bundle.clarifications);
    for (const seg of parts) adjudicateSegment(seg, entry, bundle.clarifications, catalog);
    segments.push(...parts);
  }
  return { segments };
}

// 用已确认计划给片段打限制/例外标记；不判违规的片段保持 pending。
export function applyPlanToSegments(result, plan, catalog) {
  for (const seg of result.segments) {
    const midEpoch = (seg.start.epoch + seg.end.epoch) / 2;
    const midpoint = { epoch: midEpoch, offsetMin: seg.start.offsetMin, iso: new Date(midEpoch).toISOString() };
    const purpose = seg.status === 'confirmed' || seg.status === 'hint-only' ? seg.purposes[0] : null;
    const verdict = plan.commitments.length
      ? evaluate(plan, seg.activityId, purpose, midpoint)
      : { verdict: 'allow', restrictions: [], exceptions: [], reason: '无已确认计划' };
    seg.planVerdict = verdict;
    seg.violation = null;
    // 违规只对已确认（confirmed）用途断言；仅 hint 推断或 pending 的区间不断言违规。
    if (verdict.verdict === 'block' && purpose && seg.status === 'confirmed') {
      seg.violation = { commitmentIds: verdict.restrictions.map(r => r.commitmentId), reason: verdict.reason };
    }
    seg.held = verdict.verdict === 'undecidable' || seg.status === 'pending';
    // 例外窗口外的“老师指定”不复活例外。
    if (purpose === '作业' && verdict.exceptions.length === 0 && /老师|录屏/.test(seg.hint)) {
      seg.basis.push('即便后补为老师指定，一次性例外已过期或已耗尽，不自动延长放行');
    }
  }
  return result;
}

import { evaluate } from './plan.mjs';

export function renderAdjudication(result, catalog) {
  const lines = [];
  for (const seg of result.segments) {
    const name = catalog.byId.get(seg.activityId)?.application ?? seg.activityId;
    const status = { confirmed: '已判', 'hint-only': '仅线索', pending: '待确认' }[seg.status];
    lines.push(
      `${seg.segmentId} ${name}/${seg.window} ${hm(seg.start)}-${hm(seg.end)} ${seg.minutes}分钟 [${status}] 用途=${seg.purposes.join('|') || '?'}${seg.held ? ' （保留区间，不扣配额）' : ''}${seg.violation ? ` 违规：${seg.violation.reason}` : ''}`,
    );
    for (const b of seg.basis) lines.push(`    · ${b}`);
  }
  return lines.join('\n');
}
