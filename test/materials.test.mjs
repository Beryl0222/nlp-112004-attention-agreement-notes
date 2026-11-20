import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle, readCollection } from '../tools/materials.mjs';

test('接件资料包含原文和原始记录', () => {
  const bundle = readBundle();
  const excerpts = [["notes", "n4", "19:00"], ["notes", "n3", "没说同意"], ["clarifications", "c1", "18:55"], ["reminders", "r3", "当前还可继续"]];
  for (const [group, id, phrase] of excerpts) {
    const entry = bundle[group].find(row => row.id === id);
    assert.ok(entry, `${group}/${id} 缺少来件`);
    if (phrase) assert.ok(Object.values(entry).some(value => typeof value === 'string' && value.includes(phrase)), `${group}/${id} 的源文字缺少约定片段`);
  }
});

test('拒绝缺少正式字段的接件', t => {
  const directory = mkdtempSync(join(tmpdir(), 'attention-agreement-notes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'activities.json'), JSON.stringify([{ id: 'bad' }]));
  assert.throws(() => readCollection('activities', pathToFileURL(directory + sep)), TypeError);
});

test('补记与提示可以定位到演练时间线且原区间有起止', () => {
  const { timeline, clarifications, reminders } = readBundle();
  assert.ok(timeline.every(entry => Date.parse(entry.start) < Date.parse(entry.end)));
  for (const clar of clarifications) {
    assert.ok(Date.parse(clar.at) >= Date.parse(timeline.find(entry => entry.id === clar.entry).start));
  }
  assert.ok(reminders.every(row => Number.isFinite(Date.parse(row.at))));
});
