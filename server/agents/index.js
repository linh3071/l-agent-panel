// agent 类型 → 用量读取器注册表。
//
// 新增一个 agent 只需两步：
//   1. 在 server/agents/ 下加一个读取器模块，导出 async (agent, errors) => { records, aux? }
//   2. 在下面 READERS 里注册类型名（可注册多个别名指向同一读取器）
//
// 读取器统一约定：input 含缓存读（未缓存输入 = input − cacheRead），total = input + cacheWrite + output。

import { readZcode } from './zcode.js';
import { readCodex } from './codex.js';
import { readClaude } from './claude.js';
import { readOpencode } from './opencode.js';
import { readPi } from './pi.js';
import { readDsh } from './dsh.js';

const READERS = new Map([
  ['zcode', readZcode],
  ['codex', readCodex],
  ['claude', readClaude],
  ['claude-code', readClaude], // 别名
  ['opencode', readOpencode],
  ['pi', readPi],
  ['dsh', readDsh],
]);

// 错误提示/文档用：支持的主类型名
export const SUPPORTED_TYPES = ['zcode', 'codex', 'claude', 'opencode', 'pi', 'dsh'];

export function getReader(type) {
  return READERS.get(String(type ?? '').trim().toLowerCase()) ?? null;
}
