#!/usr/bin/env node
/**
 * 构建 union 检视所用的只读查看器，并复制到 public/inspect/（开发与生产共用：
 * Vite 会原样托管 public/，构建时也会把它打进 dist/inspect/）。
 *
 * 首次运行会按需安装 tools/dc-viewer 的依赖；产物目录已 gitignore，不提交。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const viewer = path.resolve(root, '..', 'dc-viewer');
const src = path.join(viewer, 'dist');
const dst = path.join(root, 'public', 'inspect');

if (!fs.existsSync(path.join(viewer, 'package.json'))) {
  console.error(`viewer package not found: ${viewer}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(viewer, 'node_modules'))) {
  console.log('installing viewer dependencies…');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: viewer, stdio: 'inherit' });
}
if (!process.env.DCX_SKIP_VIEWER_BUILD) {
  console.log('building viewer…');
  execFileSync('npm', ['run', 'build'], { cwd: viewer, stdio: 'inherit' });
}
if (!fs.existsSync(src)) {
  console.error(`viewer dist not found: ${src}`);
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`inspect bundle ready → ${dst}`);
