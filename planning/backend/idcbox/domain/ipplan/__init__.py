"""网段级 IP 规划层（L1 纯函数，零 IO）：解析 / 容量 / 使用率 / 冲突校验。"""

from .segment import (
    IpPlan,
    IpSegment,
    Overlap,
    build_payload,
    enclosing_supernet,
    find_overlaps,
    format_segment,
    parse_ip_plan,
    parse_segment,
    to_rows,
)

__all__ = [
    "IpPlan",
    "IpSegment",
    "Overlap",
    "build_payload",
    "enclosing_supernet",
    "find_overlaps",
    "format_segment",
    "parse_ip_plan",
    "parse_segment",
    "to_rows",
]