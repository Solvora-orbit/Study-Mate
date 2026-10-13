#!/usr/bin/env node
/* 从上游 video-to-skill 的本地检出刷新 zcode/vendor/bilibili-persona。
 * 用法：node zcode/scripts/sync-video-vendor.mjs <上游检出目录>
 * 只搬运插件载荷（.zcode-plugin、skills、commands、scripts、personas、docs、LICENSE、NOTICE、README），
 * 跳过上游自己的 marketplace.json（由本仓库根的生成器统一发布）与 .git/.github。
 */
import fs from 'node:fs';
import path from 'node:path';

const [srcArg] = process.argv.slice(2);
if (!srcArg) { console.error('缺少上游检出目录参数'); process.exit(1); }
const src = path.resolve(srcArg);
const root = path.resolve(import.meta.dirname, '..', '..');
const dest = path.join(root, 'zcode', 'vendor', 'bilibili-persona');
const KEEP = ['.zcode-plugin', 'skills', 'commands', 'scripts', 'personas', 'docs', 'LICENSE', 'NOTICE', 'README.md', '.gitignore', '.zcodeignore', '.gitattributes'];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`vendor 不接受符号链接：${path.join(from, entry.name)}`);
    const f = path.join(from, entry.name), t = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(f, t); else fs.copyFileSync(f, t);
  }
}

if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
fs.mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of KEEP) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) continue;
  const to = path.join(dest, name);
  if (fs.statSync(from).isDirectory()) copyTree(from, to);
  else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  copied += 1;
}
if (copied === 0) throw new Error('上游检出里没有任何可搬运的载荷');
const manifest = JSON.parse(fs.readFileSync(path.join(dest, '.zcode-plugin', 'plugin.json'), 'utf8'));
if (manifest.name !== 'bilibili-persona') throw new Error(`vendor 清单插件名异常：${manifest.name}`);
console.log(`vendor 刷新完成：bilibili-persona ${manifest.version}`);
