import assert from 'node:assert/strict';
import test from 'node:test';
import {
  instant, hm, minutesBetween, unionMinutes, splitByBoundary, intersect, wallAtDate,
} from '../tools/lib/time.mjs';

const t = iso => instant(iso);

test('带偏移 ISO 解析与挂钟显示', () => {
  const a = t('2026-11-20T18:50:00+08:00');
  assert.equal(hm(a), '18:50');
  assert.equal(a.offsetMin, 480);
  assert.throws(() => instant('2026-11-20 18:50:00'));
});

test('半开区间分钟差，首尾相接不重复计', () => {
  const a = t('2026-11-20T18:52:00+08:00');
  const b = t('2026-11-20T18:55:00+08:00');
  const c = t('2026-11-20T18:55:00+08:00');
  const d = t('2026-11-20T19:00:00+08:00');
  assert.equal(minutesBetween(a, b), 3);
  assert.equal(unionMinutes([{ start: a, end: b }, { start: c, end: d }]), 8);
});

test('重叠窗口按并集扣除，绝不扣两遍', () => {
  const base = [
    { start: t('2026-11-20T18:50:00+08:00'), end: t('2026-11-20T19:02:00+08:00') }, // 12
    { start: t('2026-11-20T18:55:00+08:00'), end: t('2026-11-20T19:04:00+08:00') }, // 与上重叠 7
  ];
  assert.equal(unionMinutes(base), 14); // 18:50–19:04
});

test('04:00 日界把跨日区间切成两个配额日', () => {
  const iv = { start: t('2026-11-21T03:56:00+08:00'), end: t('2026-11-21T04:04:00+08:00') };
  const parts = splitByBoundary(iv, '04:00', 480);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].dayKey, '2026-11-20');
  assert.equal(minutesBetween(parts[0].start, parts[0].end), 4);
  assert.equal(parts[1].dayKey, '2026-11-21');
  assert.equal(minutesBetween(parts[1].start, parts[1].end), 4);
});

test('区间交集遵守半开语义，相切返回 null', () => {
  const a = { start: t('2026-11-20T18:55:00+08:00'), end: t('2026-11-20T19:04:00+08:00') };
  const b = { start: t('2026-11-20T19:04:00+08:00'), end: t('2026-11-20T19:10:00+08:00') };
  assert.equal(intersect(a, b), null);
  const c = { start: t('2026-11-20T19:00:00+08:00'), end: t('2026-11-20T19:06:00+08:00') };
  assert.equal(minutesBetween(intersect(a, c).start, intersect(a, c).end), 4);
});

test('wallAtDate 用固定偏移构造挂钟时刻', () => {
  const x = wallAtDate('2026-11-20', '19:00', 480);
  assert.equal(hm(x), '19:00');
  assert.equal(x.iso, new Date(Date.UTC(2026, 10, 20, 11, 0)).toISOString());
});
