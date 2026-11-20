// 本地状态：用户确认结果只保存在本机文件，资料包 data/ 保持只读事实。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_STATE_PATH = new URL('../../state/assistant-state.json', import.meta.url).pathname;

export function defaultStatePath() {
  return DEFAULT_STATE_PATH;
}

export function loadState(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) {
    return { confirmedProposalIds: [], userChoices: [], confirmedRewrites: [], savedAt: null };
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveState(state, path = DEFAULT_STATE_PATH, atIso = null) {
  mkdirSync(dirname(path), { recursive: true });
  state.savedAt = atIso; // 演练时刻，不使用设备当前时钟
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}
