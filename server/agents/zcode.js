// ZCode 用量读取器：{path}/cli/db/db.sqlite 的 model_usage 表（每请求一条：模型、token 明细、时间戳）。
// Windows 挂载（/mnt/c）或 UNC 路径下打开失败时，withSqlite 会自动复制到临时目录重试。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nonNegative, withSqlite } from './common.js';

export function readZcode(agent, errors) {
  const dbPath = join(agent.path, 'cli', 'db', 'db.sqlite');
  if (!existsSync(dbPath)) {
    errors.push({ file: dbPath, message: '数据库不存在' });
    return { records: [], aux: 0 };
  }

  try {
    return withSqlite(dbPath, (db) => {
      const directories = new Map();
      const titles = new Map();
      try {
        for (const row of db.prepare('SELECT id, directory, title FROM session').all()) {
          directories.set(row.id, row.directory);
          if (row.title) titles.set(row.id, row.title);
        }
      } catch {
        // session 表不可读时项目/标题列留空
      }

      const stmt = db.prepare(`
        SELECT session_id, query_source, provider_id, model_id, started_at,
               input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
        FROM model_usage
      `);
      const records = [];
      let aux = 0;
      for (const row of stmt.all()) {
        const input = nonNegative(row.input_tokens);
        const output = nonNegative(row.output_tokens);
        const cacheRead = nonNegative(row.cache_read_input_tokens);
        const cacheWrite = nonNegative(row.cache_creation_input_tokens);
        const total = nonNegative(row.computed_total_tokens) || input + output + cacheRead + cacheWrite;
        if (total <= 0) continue; // 过滤无 token 的取消请求
        const startedAt = Number(row.started_at);
        if (!Number.isFinite(startedAt)) continue;

        if (row.query_source === 'session_title') {
          aux += 1; // 标题生成请求不计入主统计（对齐参考实现）
          continue;
        }
        records.push({
          agent: agent.name,
          provider: row.provider_id || 'unknown',
          model: row.model_id || 'unknown',
          time: startedAt,
          input,
          cacheRead,
          cacheWrite,
          output,
          total,
          sessionId: row.session_id || '',
          project: directories.get(row.session_id) || '',
          title: titles.get(row.session_id) || '',
        });
      }
      return { records, aux };
    });
  } catch (error) {
    errors.push({ file: dbPath, message: `读取失败：${error.message}` });
    return { records: [], aux: 0 };
  }
}

