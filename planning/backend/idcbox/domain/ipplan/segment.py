"""网段级 IP 规划（FR-3.8 轻量版，纯函数零 IO）。

## 这个模块解决什么

客户真实交付物 `V13…设备上架规划.xlsx` 里有一张「IP地址段规划」表，
形态是「应用范围 → IP地址段」，只有 10 行数据：

```
交换机互联地址      172.30.0.0/24
（同上）            172.30.100.0/24
服务器管理地址      172.30.1.0/24-172.30.15.0/24
…
租户浮动IP地址      172.30.127.0/24-172.30.249.0/24
（同上）            172.31.0.0/16
```

产品规划（`docs/product/01-产品规划.md`）明确**不做 IPAM**（逐地址分配是过度设计），
但调研（`docs/research/04-commercial-products.md` P1-2）识别出「网段规划 + 使用率 +
冲突校验」是合理的轻量能力。本模块就是那个轻量能力：把自由文本的网段登记
**解析成结构化模型**，算容量、查冲突、统计地址空间使用率。

## 两种网段形态（忠实于真实数据，不臆造）

1. **单 CIDR**：`172.30.0.0/24`、`172.31.0.0/16`。
2. **CIDR 区间**：`172.30.1.0/24-172.30.15.0/24` —— 同前缀长度的一段连续子网
   （这里是 15 个 /24）。**不是**一个聚合 CIDR（1~15 不是 2 的幂对齐块），
   所以按子网逐个展开，容量 = 子网数 × 每子网地址数。

## 诚实边界

- **使用率是「规划占用 / 最小覆盖超网容量」**，不是实际分配率 —— 源表只有规划网段，
  没有逐地址分配数据，假装能算「已用多少 IP」就是说假话。界面必须照此口径标注。
- **冲突校验是网段级重叠**（两个登记网段共享地址），不是主机路由冲突。
- 解析失败的行**记为 issue 不静默丢弃**，也不让一行坏数据毁掉整张表。
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Iterable

#: 区间分隔符：真实数据用 ASCII `-`，兼容中文破折号与 `~`。
_RANGE_SEP = re.compile(r"\s*[-–—~]\s*")


@dataclass(frozen=True, slots=True)
class IpSegment:
    """一条登记网段。`networks` 是展开后的子网元组（单 CIDR 长度为 1）。"""

    purpose: str
    raw: str
    networks: tuple[ipaddress.IPv4Network, ...]

    @property
    def kind(self) -> str:
        return "range" if len(self.networks) > 1 else "cidr"

    @property
    def subnet_count(self) -> int:
        return len(self.networks)

    @property
    def address_count(self) -> int:
        return sum(n.num_addresses for n in self.networks)

    @property
    def start(self) -> ipaddress.IPv4Address:
        return min(n.network_address for n in self.networks)

    @property
    def end(self) -> ipaddress.IPv4Address:
        return max(n.broadcast_address for n in self.networks)


@dataclass(frozen=True, slots=True)
class Overlap:
    """两条登记网段共享地址。`shared` 是重叠子网对数，`example` 是其中一个重叠子网。"""

    a_purpose: str
    a_raw: str
    b_purpose: str
    b_raw: str
    shared: int
    example: str


@dataclass(frozen=True, slots=True)
class IpPlan:
    segments: tuple[IpSegment, ...]
    issues: tuple[str, ...]


def parse_segment(purpose: str, raw: str) -> IpSegment:
    """把一行「IP地址段」文本解析成 `IpSegment`。无法解析时抛 `ValueError`。

    >>> parse_segment("交换机互联地址", "172.30.0.0/24").address_count
    256
    >>> parse_segment("服务器管理地址", "172.30.1.0/24-172.30.15.0/24").subnet_count
    15
    >>> parse_segment("租户浮动IP地址", "172.31.0.0/16").address_count
    65536
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("网段为空")
    parts = _RANGE_SEP.split(text)
    if len(parts) == 2:
        return _parse_range(purpose, text, parts[0], parts[1])
    if len(parts) != 1:
        raise ValueError(f"无法识别的网段格式：{text!r}")
    try:
        net = ipaddress.IPv4Network(text, strict=False)
    except ValueError as exc:
        raise ValueError(f"非法 CIDR：{text!r}（{exc}）") from exc
    return IpSegment(purpose=purpose, raw=text, networks=(net,))


def _parse_range(purpose: str, text: str, left: str, right: str) -> IpSegment:
    try:
        a = ipaddress.IPv4Network(left.strip(), strict=False)
        b = ipaddress.IPv4Network(right.strip(), strict=False)
    except ValueError as exc:
        raise ValueError(f"区间端点非法：{text!r}（{exc}）") from exc
    if a.prefixlen != b.prefixlen:
        raise ValueError(f"区间两端前缀长度不一致：{text!r}")
    if int(b.network_address) < int(a.network_address):
        raise ValueError(f"区间起点大于终点：{text!r}")
    step = 2 ** (32 - a.prefixlen)
    start, end = int(a.network_address), int(b.network_address)
    networks = tuple(
        ipaddress.IPv4Network((addr, a.prefixlen))
        for addr in range(start, end + 1, step)
    )
    return IpSegment(purpose=purpose, raw=text, networks=networks)


def parse_ip_plan(rows: Iterable[tuple[str, str]]) -> IpPlan:
    """把「(应用范围, IP地址段)」行序列解析成规划。

    应用范围留空表示**沿用上一条**（真实表里同一用途的多个网段，用途只写首行）。
    单行解析失败记入 `issues`，不影响其余行。

    >>> plan = parse_ip_plan([("交换机互联地址", "172.30.0.0/24"), ("", "172.30.100.0/24")])
    >>> len(plan.segments), plan.segments[1].purpose
    (2, '交换机互联地址')
    """
    segments: list[IpSegment] = []
    issues: list[str] = []
    purpose = ""
    for idx, (raw_purpose, raw_seg) in enumerate(rows, start=1):
        p = (raw_purpose or "").strip()
        if p:
            purpose = p
        text = (raw_seg or "").strip()
        if not text:
            continue
        try:
            segments.append(parse_segment(purpose, text))
        except ValueError as exc:
            issues.append(f"第 {idx} 行「{text}」：{exc}")
    return IpPlan(segments=tuple(segments), issues=tuple(issues))


def find_overlaps(segments: tuple[IpSegment, ...]) -> tuple[Overlap, ...]:
    """两两检查网段重叠。真实 V13 的 10 条网段互不重叠，返回空。

    >>> a = parse_segment("甲", "172.30.0.0/24")
    >>> b = parse_segment("乙", "172.30.0.0/25")
    >>> len(find_overlaps((a, b)))
    1
    >>> c = parse_segment("丙", "172.30.1.0/24")
    >>> find_overlaps((a, c))
    ()
    """
    out: list[Overlap] = []
    for i in range(len(segments)):
        for j in range(i + 1, len(segments)):
            a, b = segments[i], segments[j]
            shared = [
                (na, nb)
                for na in a.networks
                for nb in b.networks
                if na.overlaps(nb)
            ]
            if not shared:
                continue
            na, nb = shared[0]
            smaller = na if na.prefixlen >= nb.prefixlen else nb
            out.append(
                Overlap(
                    a_purpose=a.purpose,
                    a_raw=a.raw,
                    b_purpose=b.purpose,
                    b_raw=b.raw,
                    shared=len(shared),
                    example=str(smaller),
                )
            )
    return tuple(out)


def enclosing_supernet(segments: tuple[IpSegment, ...]) -> ipaddress.IPv4Network | None:
    """覆盖全部网段的最小超网。使用率的分母。

    >>> segs = parse_ip_plan([("甲", "172.30.0.0/24"), ("乙", "172.31.0.0/16")]).segments
    >>> str(enclosing_supernet(segs))
    '172.30.0.0/15'
    """
    if not segments:
        return None
    lo = min(int(n.network_address) for s in segments for n in s.networks)
    hi = max(int(n.broadcast_address) for s in segments for n in s.networks)
    for prefix in range(32, -1, -1):
        net = ipaddress.IPv4Network((lo, prefix), strict=False)
        if int(net.broadcast_address) >= hi:
            return net
    return None


def format_segment(segment: IpSegment) -> str:
    """还原成源表文本（导出回写用）。区间还原为 `起/前缀-止/前缀`。

    >>> format_segment(parse_segment("甲", "172.30.1.0/24-172.30.15.0/24"))
    '172.30.1.0/24-172.30.15.0/24'
    """
    if len(segment.networks) == 1:
        return str(segment.networks[0])
    return f"{segment.networks[0]}-{segment.networks[-1]}"


def to_rows(segments: tuple[IpSegment, ...]) -> list[tuple[str, str]]:
    """导出成「(应用范围, IP地址段)」行；同一用途只首行写用途，其余留空（沿用源表格式）。"""
    rows: list[tuple[str, str]] = []
    last: str | None = None
    for s in segments:
        purpose = s.purpose if s.purpose != last else ""
        last = s.purpose
        rows.append((purpose, format_segment(s)))
    return rows


def build_payload(plan: IpPlan) -> dict:
    """把解析结果投影成前端可直接渲染的 JSON 形状（纯函数）。"""
    segments = plan.segments
    by_purpose: dict[str, dict] = {}
    for s in segments:
        entry = by_purpose.setdefault(
            s.purpose,
            {"purpose": s.purpose, "segmentCount": 0, "subnetCount": 0, "addressCount": 0},
        )
        entry["segmentCount"] += 1
        entry["subnetCount"] += s.subnet_count
        entry["addressCount"] += s.address_count

    total_addresses = sum(s.address_count for s in segments)
    total_subnets = sum(s.subnet_count for s in segments)
    supernet = enclosing_supernet(segments)
    capacity = supernet.num_addresses if supernet else 0
    conflicts = find_overlaps(segments)

    return {
        "segments": [
            {
                "purpose": s.purpose,
                "raw": s.raw,
                "kind": s.kind,
                "subnetCount": s.subnet_count,
                "addressCount": s.address_count,
                "start": str(s.start),
                "end": str(s.end),
            }
            for s in segments
        ],
        "byPurpose": list(by_purpose.values()),
        "totals": {
            "segments": len(segments),
            "purposes": len(by_purpose),
            "subnets": total_subnets,
            "addresses": total_addresses,
        },
        "utilization": {
            "supernet": str(supernet) if supernet else "",
            "capacity": capacity,
            "planned": total_addresses,
            "ratio": round(total_addresses / capacity, 4) if capacity else 0.0,
        },
        "conflicts": [
            {
                "aPurpose": c.a_purpose,
                "aRaw": c.a_raw,
                "bPurpose": c.b_purpose,
                "bRaw": c.b_raw,
                "shared": c.shared,
                "example": c.example,
            }
            for c in conflicts
        ],
        "issues": list(plan.issues),
        "notes": [
            "使用率 = 规划地址数 / 最小覆盖超网容量，是规划占用口径，不是实际分配率。",
            "冲突校验为网段级重叠（两条登记网段共享地址），非主机路由冲突。",
        ],
    }


__all__ = [
    "IpSegment",
    "IpPlan",
    "Overlap",
    "parse_segment",
    "parse_ip_plan",
    "find_overlaps",
    "enclosing_supernet",
    "format_segment",
    "to_rows",
    "build_payload",
]