#!/usr/bin/env node
/**
 * 开发期参考站镜像：把 https://www.nvisual.com/DCExporer/ 的静态资源树抓取到 .ref/。
 *
 * 用途仅限核对数值/行为（几何尺寸、材质参数、文案常量）。.ref/ 已被 gitignore，
 * 不参与构建，也不会进入交付物。
 *
 *   node scripts/fetch-reference.mjs [--base URL] [--out DIR]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, posix } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = argOf('--base', 'https://www.nvisual.com/DCExporer/');
const OUT = argOf('--out', '.ref');

const QUEUE = ['index.html'];
const seen = new Set();
const skipped = new Set();

const isExternal = u => /^(https?:|data:|blob:|mailto:|javascript:|\/\/|#)/i.test(u);

function refsOf(rel, text) {
  const out = [];
  const add = q => {
    if (!q || isExternal(q)) return;
    const clean = q.split('?')[0].split('#')[0];
    if (!clean) return;
    out.push(normalize(posix.join(posix.dirname(rel), clean)));
  };
  for (const m of text.matchAll(/import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)) add(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi)) add(m[1]);
  return out;
}

async function main() {
  while (QUEUE.length) {
    const rel = normalize(QUEUE.shift());
    if (seen.has(rel) || skipped.has(rel)) continue;
    seen.add(rel);
    const url = new URL(rel, BASE).href;
    let res;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (err) {
      console.warn(`SKIP ${rel}: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      console.warn(`SKIP ${rel}: HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = join(OUT, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    if (/\.(?:js|mjs|css|html)$/i.test(rel)) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      for (const q of refsOf(rel, text)) {
        if (!seen.has(q)) QUEUE.push(q);
      }
    }
  }
  console.log(`mirrored ${seen.size} assets → ${OUT}/`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
