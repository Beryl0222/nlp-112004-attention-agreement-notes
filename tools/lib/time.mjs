// 演练时间工具：全部时间带偏移量，区间含开始、不含结束（半开区间）。
// 不使用设备当前时钟，所有计算只依赖资料里的演练时刻。

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?([+-])(\d{2}):(\d{2})$/;
const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/;

export function instant(iso) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) {
    throw new Error(`无法解析带偏移的 ISO 时间：${iso}`);
  }
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) throw new Error(`无法解析时间：${iso}`);
  const off = OFFSET_RE.exec(iso);
  const offsetMin = (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
  return { epoch, offsetMin, iso };
}

export function wall(t) {
  const d = new Date(t.epoch + t.offsetMin * 60000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  };
}

const pad = n => String(n).padStart(2, '0');

export function hm(t) {
  const w = wall(t);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

export function dateKey(t) {
  const w = wall(t);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

// 在某一挂钟日期的 HH:MM 构造时刻，沿用给定偏移。
export function wallAtDate(key, hhmm, offsetMin) {
  const [y, mo, d] = key.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const epoch = Date.UTC(y, mo - 1, d, h, mi) - offsetMin * 60000;
  return { epoch, offsetMin, iso: new Date(epoch).toISOString() };
}

export function sameWallDate(a, b) {
  return dateKey(a) === dateKey(b);
}

export function minutesBetween(a, b) {
  return (b.epoch - a.epoch) / 60000;
}

export function isBefore(a, b) {
  return a.epoch < b.epoch;
}

export function maxInstant(a, b) {
  return a.epoch >= b.epoch ? a : b;
}

export function minInstant(a, b) {
  return a.epoch <= b.epoch ? a : b;
}

// 两个半开区间的交集（无交集返回 null）。
export function intersect(a, b) {
  const start = maxInstant(a.start, b.start);
  const end = minInstant(a.end, b.end);
  if (start.epoch >= end.epoch) return null;
  return { start, end };
}

// 合并重叠或首尾相接的区间，按真实经过时间求并集。
export function union(intervals) {
  const sorted = intervals
    .filter(iv => iv.end.epoch > iv.start.epoch)
    .sort((a, b) => a.start.epoch - b.start.epoch);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start.epoch <= last.end.epoch) {
      if (iv.end.epoch > last.end.epoch) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

export function unionMinutes(intervals) {
  return union(intervals).reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
}

function shiftDay(key, delta) {
  const [y, mo, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// 按当地日界（如 04:00）切分区间，返回带配额日键的片段；
// 03:56–04:04 会被切成前一日 4 分钟与当日 4 分钟。
export function splitByBoundary(interval, boundaryHHMM, offsetMin) {
  const [bh, bmi] = boundaryHHMM.split(':').map(Number);
  const boundaryMin = bh * 60 + bmi;
  const quotaKeyOf = t => {
    const w = wall(t);
    const key = dateKey(t);
    return w.h * 60 + w.mi < boundaryMin ? shiftDay(key, -1) : key;
  };
  const parts = [];
  let cursor = interval.start;
  let guard = 0;
  while (cursor.epoch < interval.end.epoch && guard < 1000) {
    guard += 1;
    const key = quotaKeyOf(cursor);
    const nextBoundary = wallAtDate(shiftDay(key, 1), boundaryHHMM, offsetMin);
    const end = nextBoundary.epoch < interval.end.epoch ? nextBoundary : interval.end;
    parts.push({ dayKey: key, start: cursor, end });
    cursor = end;
  }
  return parts;
}
