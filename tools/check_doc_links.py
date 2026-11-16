#!/usr/bin/env python3
"""文档本地链接与孤儿体检。

扫描仓库内 Markdown 的 inline 链接/图片，解析相对路径并核对存在性；
统计入链找出没有被任何文档/前端/README 引用的孤儿文档。

用法：
    python3 tools/check_doc_links.py            # 全量体检
    python3 tools/check_doc_links.py --quiet     # 只输出问题与计数

约定（docs/README.md「维护约定」）：修改功能时检查本地链接与中文编码。
本工具只读，不改任何文件；退出码 0=无断链，1=有断链。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent

EXCLUDE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "dist", "build",
    "__pycache__", ".scratch", ".out", "coverage", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".bak", "信息港部署上架",
}

# inline 链接与图片：[text](target) / ![alt](target)
LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
# 前端/README 里指向 docs 的 GitHub blob 链接或相对路径
DOC_REF_RE = re.compile(r"(?:/blob/[^/]+/|(?<![\w/]))(docs/[^\s)\"'`<>]+\.md)")

SKIP_PREFIXES = ("http://", "https://", "mailto:", "//", "#", "data:")


def iter_md() -> list[Path]:
    out: list[Path] = []
    for p in ROOT.rglob("*.md"):
        if any(part in EXCLUDE_DIRS for part in p.relative_to(ROOT).parts):
            continue
        out.append(p)
    return sorted(out)


def split_target(raw: str) -> str | None:
    """返回需要核对存在性的本地路径部分；外部/锚点/模板返回 None。"""
    t = raw.strip()
    if t.startswith(SKIP_PREFIXES) or "${" in t or t.startswith("<"):
        return None
    t = t.split("#", 1)[0].split("?", 1)[0]
    if not t:
        return None
    return unquote(t)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    mds = iter_md()
    broken: list[tuple[str, int, str]] = []
    inbound: set[Path] = set()
    link_count = 0

    for md in mds:
        text = md.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            for m in LINK_RE.finditer(line):
                target = split_target(m.group(1))
                if target is None:
                    continue
                link_count += 1
                resolved = (md.parent / target).resolve()
                if resolved.exists():
                    if resolved.suffix == ".md":
                        inbound.add(resolved)
                else:
                    broken.append((str(md.relative_to(ROOT)), lineno, m.group(1)))

    # 前端与根 README 对 docs/ 的引用（产品页保留路径）
    extra_sources = [ROOT / "README.md"]
    fe = ROOT / "frontend" / "src"
    if fe.exists():
        extra_sources += [p for p in fe.rglob("*") if p.suffix in {".vue", ".js", ".ts"}]
    for src in extra_sources:
        if not src.exists():
            continue
        text = src.read_text(encoding="utf-8", errors="replace")
        for m in DOC_REF_RE.finditer(text):
            ref = unquote(m.group(1).split("#", 1)[0])
            resolved = (ROOT / ref).resolve()
            if resolved.exists() and resolved.suffix == ".md":
                inbound.add(resolved)

    # 孤儿：docs/ 与 planning/docs/ 下、非 README、无入链
    orphans: list[str] = []
    for md in mds:
        rel = md.relative_to(ROOT)
        parts = rel.parts
        in_doc_area = parts[0] == "docs" or (parts[0] == "planning" and "docs" in parts)
        if not in_doc_area or md.name == "README.md":
            continue
        if md.resolve() not in inbound:
            orphans.append(str(rel))

    print(f"扫描 Markdown：{len(mds)} 篇 · 本地链接：{link_count} 条")
    print(f"断链：{len(broken)} · 孤儿文档：{len(orphans)}")
    if broken:
        print("\n== 断链 ==")
        for f, ln, t in broken:
            print(f"  {f}:{ln} -> {t}")
    if orphans:
        print("\n== 孤儿（无入链，非索引）==")
        for o in orphans:
            print(f"  {o}")
    if not args.quiet and not broken and not orphans:
        print("\n全部本地链接可达，文档均有入链。")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())