#!/usr/bin/env node
/**
 * 把 union 检视所用的查看器构建产物复制到本应用 dist/inspect/。
 * 前置：../dc-viewer 已 npm install；本脚本会先跑其构建。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const viewer = path.resolve(root, '..', 'dc-viewer');
const src = path.join(viewer, 'dist');
const dst = path.join(root, 'dist', 'inspect');

if (!fs.existsSync(path.join(viewer, 'package.json'))) {
  console.error(`viewer package not found: ${viewer}`);
  process.exit(1);
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
console.log(`inspect bundle copied → ${dst}`);
