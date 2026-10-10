// agent-panel 服务入口：静态文件 + 限额/用量 API

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { queryQuota } from './quota.js';
import { queryUsage } from './usage.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = join(ROOT, 'web');
const CONFIG_PATH = join(ROOT, 'config.json');

// 便携版（启动器设置 AGENT_PANEL_IDLE_EXIT_SECONDS）下，页面心跳停止即视为窗口已关闭，
// 服务端自动退出，避免驻留后台；start.sh 启动的常驻服务不设该变量，行为不变。
const IDLE_EXIT_MS = Math.max(0, Number(process.env.AGENT_PANEL_IDLE_EXIT_SECONDS) || 0) * 1000;
const FIRST_PING_GRACE_MS = 10 * 60_000; // 启动后一直没有任何页面连接（窗口没打开）时的兜底
let lastPingAt = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 每次请求重新读取配置，改 config.json 无需重启
async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`读取 config.json 失败：${error.message}`);
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// 静态资源版本号：基于文件 mtime，内容变化时 URL 随之变化，避免浏览器旧缓存
async function assetVersion() {
  const parts = [];
  for (const name of ['style.css', 'app.js']) {
    try {
      parts.push(String((await stat(join(WEB_DIR, name))).mtimeMs));
    } catch {
      parts.push(name);
    }
  }
  return createHash('md5').update(parts.join('|')).digest('hex').slice(0, 8);
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = join(WEB_DIR, relative);
  if (!filePath.startsWith(WEB_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    let content = await readFile(filePath);
    if (relative === 'index.html') {
      const version = await assetVersion();
      content = Buffer.from(content.toString('utf8').replace(/((?:href|src)="\/(?:style\.css|app\.js))"/g, `$1?v=${version}"`));
      response.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Cache-Control': 'no-store',
      });
      response.end(content);
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
}

async function main() {
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(`[startup] ${error.message}`);
    process.exit(1);
  }
  const host = config.server?.host ?? '127.0.0.1';
  const port = Number(config.server?.port) || 8787;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const started = Date.now();

    try {
      if (request.method === 'POST' && pathname === '/api/quota/query') {
        const body = await readBody(request);
        const live = await loadConfig();
        const result = await queryQuota(live.quota?.providers ?? [], typeof body.key === 'string' ? body.key : null);
        sendJson(response, 200, result);
      } else if (request.method === 'POST' && pathname === '/api/usage/query') {
        const body = await readBody(request);
        const live = await loadConfig();
        const result = await queryUsage(live.usage?.agents ?? [], {
          from: body.from,
          to: body.to,
          groupBy: body.groupBy === 'model' ? 'model' : 'agent',
        });
        sendJson(response, 200, result);
      } else if (pathname === '/api/ping') {
        lastPingAt = Date.now();
        sendJson(response, 200, { ok: true });
      } else if (request.method === 'GET') {
        await serveStatic(request, response, pathname);
      } else {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
      }
      console.log(`[http] ${request.method} ${pathname} ${Date.now() - started}ms`);
    } catch (error) {
      console.error(`[http] ${request.method} ${pathname} failed:`, error);
      sendJson(response, 500, { error: error?.message ?? String(error) });
    }
  });

  server.listen(port, host, () => {
    console.log(`[agent-panel] listening on http://${host}:${port}`);
    console.log(`[agent-panel] web dir: ${WEB_DIR}`);
    console.log(`[agent-panel] config: ${CONFIG_PATH}（修改后无需重启，下次请求生效）`);
    if (IDLE_EXIT_MS) {
      console.log(`[agent-panel] 便携模式：页面心跳停止 ${Math.round(IDLE_EXIT_MS / 1000)}s 后自动退出`);
      const startedAt = Date.now();
      setInterval(() => {
        const now = Date.now();
        if (!lastPingAt) {
          if (now - startedAt > FIRST_PING_GRACE_MS) {
            console.log('[agent-panel] 启动后始终没有页面连接，自动退出');
            process.exit(0);
          }
          return;
        }
        if (now - lastPingAt > IDLE_EXIT_MS) {
          console.log(`[agent-panel] 页面心跳已停止 ${Math.round((now - lastPingAt) / 1000)}s，自动退出`);
          process.exit(0);
        }
      }, 2000);
    }
  });
}

main().catch((error) => {
  console.error('[agent-panel] fatal:', error);
  process.exit(1);
});
