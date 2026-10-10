// 各 agent 用量读取器的共用工具。

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 在只读数据库上执行 fn；打开或查询失败（如 /mnt/c 挂载上 WAL 的 disk I/O error，
// 或 UNC 路径下的 database is locked）时复制到临时目录重试，用完清理
export function withSqlite(path, fn) {
  try {
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (error) {
      throw Object.assign(new Error(error.message), { openFailed: true });
    }
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (!error.openFailed && !/disk I\/O error|readonly|database is locked/i.test(error.message ?? '')) {
      throw error; // 查询逻辑错误（如表不存在），复制重试无意义
    }
    const copyPath = join(tmpdir(), `agent-panel-${randomUUID()}-${basename(path)}`);
    copyFileSync(path, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      try {
        if (statSync(path + suffix).size > 0) copyFileSync(path + suffix, copyPath + suffix);
      } catch {
        // wal/shm 不存在或不可读则忽略
      }
    }
    // 副本用读写模式打开：副本携带 wal 时，只读打开无法做 WAL 恢复
    const db = new DatabaseSync(copyPath);
    try {
      return fn(db);
    } finally {
      db.close();
      for (const p of [copyPath, copyPath + '-wal', copyPath + '-shm']) {
        try {
          unlinkSync(p);
        } catch {
          // 清理失败忽略
        }
      }
    }
  }
}

export function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

export function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

// 递归收集文件：按扩展名/文件名过滤，限制深度，防御异常目录结构
export function walkFiles(root, { depth = 4, maxFiles = 20000, match } = {}) {
  const out = [];
  const isMatch = typeof match === 'function' ? match : () => true;
  const visit = (dir, level) => {
    if (level > depth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full, level + 1);
      else if (entry.isFile() && isMatch(entry.name, full)) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

export function statSafe(file) {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

// 文件级解析缓存：文件 (mtime, size) 未变则复用上次的解析结果
export function createRecordCache() {
  const map = new Map();
  return {
    get(file, stat) {
      const cached = map.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.records;
      map.delete(file);
      return null;
    },
    put(file, stat, records) {
      map.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records });
    },
  };
}

// 解析一行 JSON，失败返回 null
export function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
