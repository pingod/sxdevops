"""网段级 IP 规划的应用层投影 —— 把源表行变成前端可渲染的 JSON。

## 为什么这一层这么薄

解析 CIDR、展开区间、算容量、查冲突、求最小覆盖超网，全在域层
`domain/ipplan`（零 IO、可脱离 Excel 单测）。应用层不重复这些逻辑，
只做两件事：

1. 作为 **api → application → domain** 的接缝：API 不该直接 import 域层，
   否则五契约里的分层就破了。
2. 附上**出处**（哪个源文件的哪张表）—— 这是环境相关的事，域层不该知道。

## 为什么输入是「行」而不是文件路径

读盘是基础设施的事（`infrastructure/xlsx/ipplan_sheet.read_ip_plan_rows`），
由 API 注入行序列。这样这个服务在测试里喂几行字符串就能跑，
不需要真的造一个 xlsx —— 与 `modeladmin` 注入 `entries` 是同一个倒置手法。
"""

from __future__ import annotations

from typing import Any, Iterable

from ...domain.ipplan import build_payload, parse_ip_plan, to_rows


def ipplan_payload(
    rows: Iterable[tuple[str, str]], *, source: str = ""
) -> dict[str, Any]:
    """规划全量投影：网段明细 + 按用途汇总 + 容量/使用率 + 冲突 + 解析提示。"""
    payload = build_payload(parse_ip_plan(rows))
    payload["source"] = source
    return payload


def ipplan_export_rows(rows: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    """导出回写用的行：解析后按源表格式还原（同一用途只首行写用途）。

    走「解析 → 还原」而不是原样回吐，是为了让导出与界面看到的是**同一份模型**：
    将来支持编辑时，改的是模型，导出自然跟着变，不会出现「界面改了导出没改」。
    """
    return to_rows(parse_ip_plan(rows).segments)


__all__ = ["ipplan_export_rows", "ipplan_payload"]