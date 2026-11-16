"""「IP地址段规划」sheet 的读写（基础设施层，允许出现 openpyxl）。

## 为什么单独一个适配器，而不并进 `XlsxProjectSource`

`XlsxProjectSource` 共享一次工作簿打开，服务的是**首屏必用**的平面图 + 布线表
（冷启动 4.2s → 0.35s 的关键）。IP 规划是低频的独立页签，把它塞进共享会话
会让每次首屏都多读一张用不到的表。这里按需单独打开、读完即关，互不拖累。

## 为什么按表头名匹配而不是固定第 1、2 列

跟 `model_sheet.py` / `intent_sheet.py` 同一个理由：用户会插列、加备注、调顺序。
按列位置读，插一列「备注」就整体错位且不报错 —— 最危险的一类静默 bug。
所以先找含「应用范围」「IP地址段」的表头行，再按名取列。

## 读出来的是「原始文本」，不是结构化网段

这一层只负责把单元格变成 `(应用范围, IP地址段)` 字符串对，**不解析 CIDR**。
解析、容量、冲突全在域层 `domain/ipplan`（零 IO、可单测）。
基础设施碰 ipaddress 就越层了，也会让解析逻辑没法脱离 Excel 测试。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .openpyxl_reader import load_workbook

SHEET_NAME = "IP地址段规划"

#: 表头两列。按名匹配，顺序可变。
HEADERS: tuple[str, ...] = ("应用范围", "IP地址段")

_HEADER_FILL = PatternFill("solid", fgColor="FF1F4E79")
_HEADER_FONT = Font(name="微软雅黑", size=10, bold=True, color="FFFFFFFF")
_BODY_FONT = Font(name="微软雅黑", size=10)
_THIN = Side(style="thin", color="FFBFBFBF")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _norm(value: object) -> str:
    """表头匹配用的归一：去空格与全角空格。"""
    return str(value or "").replace(" ", "").replace("\u3000", "").strip()


def read_ip_plan_rows(
    path: str | Path, *, sheet: str = SHEET_NAME
) -> tuple[list[tuple[str, str]], tuple[str, ...]]:
    """读「IP地址段规划」表，返回 (行列表, 提示列表)。

    行是 `(应用范围, IP地址段)` 原始文本对；应用范围留空原样保留为 `""`
    （沿用上一条用途的语义由域层处理）。缺 sheet / 缺表头记入提示，不抛异常 ——
    一个没有 IP 规划表的项目不该让整个引擎报错。
    """
    wb = load_workbook(path, data_only=True, read_only=True)
    try:
        if sheet not in wb.sheetnames:
            return [], (
                f"没有找到 sheet「{sheet}」（现有：{'、'.join(wb.sheetnames)}）",
            )
        ws = wb[sheet]
        rows: list[tuple[str, str]] = []
        purpose_col: int | None = None
        seg_col: int | None = None
        for raw in ws.iter_rows(values_only=True):
            if purpose_col is None:
                norm = [_norm(v) for v in raw]
                if "应用范围" in norm and "IP地址段" in norm:
                    purpose_col = norm.index("应用范围")
                    seg_col = norm.index("IP地址段")
                continue
            purpose = str(raw[purpose_col]).strip() if purpose_col < len(raw) and raw[purpose_col] is not None else ""
            seg = str(raw[seg_col]).strip() if seg_col is not None and seg_col < len(raw) and raw[seg_col] is not None else ""
            if not purpose and not seg:
                continue
            rows.append((purpose, seg))
        if purpose_col is None:
            return [], (
                f"sheet「{sheet}」缺少表头（需要「应用范围」「IP地址段」两列）",
            )
        return rows, ()
    finally:
        wb.close()


def build_ip_plan_workbook(rows: Sequence[tuple[str, str]]) -> Workbook:
    """把 `(应用范围, IP地址段)` 行写成两列工作簿（导出回写用）。

    版式与源表一致：首行表头、同一用途只首行写用途其余留空。
    调用方负责传已经 carry-forward 处理过的行（域层 `to_rows`）。
    """
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_NAME
    for i, h in enumerate(HEADERS, start=1):
        cell = ws.cell(row=1, column=i, value=h)
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = _BORDER
    for r, (purpose, seg) in enumerate(rows, start=2):
        for c, value in enumerate((purpose, seg), start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.font = _BODY_FONT
            cell.border = _BORDER
            cell.alignment = Alignment(vertical="center")
    ws.column_dimensions[get_column_letter(1)].width = 24
    ws.column_dimensions[get_column_letter(2)].width = 44
    ws.freeze_panes = "A2"
    return wb


def write_ip_plan_xlsx(rows: Sequence[tuple[str, str]], path: str | Path) -> Path:
    """落盘成 .xlsx（先写 .tmp 再原子替换，避免半截文件）。"""
    wb = build_ip_plan_workbook(rows)
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    wb.save(tmp)
    tmp.replace(out)
    return out


__all__ = [
    "HEADERS",
    "SHEET_NAME",
    "build_ip_plan_workbook",
    "read_ip_plan_rows",
    "write_ip_plan_xlsx",
]