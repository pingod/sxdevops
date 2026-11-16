"""网段级 IP 规划的解析 / 容量 / 使用率 / 冲突（纯域层用例，不需要真实源文件）。

## 这组用例守护的四个「差一格就出错」的地方

1. **区间不是聚合 CIDR**：`172.30.1.0/24-172.30.15.0/24` 是 15 个 /24（3840 地址），
   不是某个 2 的幂对齐块。当成单个 CIDR 会把容量算错一个数量级。
2. **用途留空 = 沿用上一条**：真实表同一用途的多个网段，用途只写首行。
   不沿用就会把第二条网段归到空用途，按用途汇总少算。
3. **使用率分母是最小覆盖超网**：172.30.x 与 172.31.0.0/16 的最小覆盖是 /15
   （131072），不是 /16。分母选错使用率就翻倍或减半。
4. **坏行记 issue 不毁全表**：一行非法 CIDR 不能让整张规划打不开。
"""

from __future__ import annotations

import pytest

from idcbox.domain.ipplan import (
    build_payload,
    enclosing_supernet,
    find_overlaps,
    format_segment,
    parse_ip_plan,
    parse_segment,
    to_rows,
)

#: 真实 V13「IP地址段规划」表的 10 行（应用范围, IP地址段）。
REAL_V13_ROWS = [
    ("交换机互联地址", "172.30.0.0/24"),
    ("", "172.30.100.0/24"),
    ("服务器管理地址", "172.30.1.0/24-172.30.15.0/24"),
    ("服务器业务地址", "172.30.16.0/24-172.30.30.0/24"),
    ("SDN业务地址", "172.30.31.0/24-172.30.42.0/24"),
    ("交换机管理地址", "172.30.43.0/24-172.30.50.0/24"),
    ("服务器存储地址", "172.30.51.0/24-172.30.65.0/24"),
    ("服务器带外管理地址", "172.30.101.0/24-172.30.115.0/24"),
    ("租户浮动IP地址", "172.30.127.0/24-172.30.249.0/24"),
    ("", "172.31.0.0/16"),
]


class TestParseSegment:
    """单 CIDR 与区间两种形态。"""

    @pytest.mark.parametrize(
        ("raw", "addresses", "subnets", "kind"),
        [
            ("172.30.0.0/24", 256, 1, "cidr"),
            ("172.31.0.0/16", 65536, 1, "cidr"),
            ("172.30.1.0/24-172.30.15.0/24", 3840, 15, "range"),
            ("172.30.127.0/24-172.30.249.0/24", 31488, 123, "range"),
            ("10.0.0.0/8", 16777216, 1, "cidr"),
        ],
    )
    def test_capacity_and_kind(self, raw, addresses, subnets, kind) -> None:
        seg = parse_segment("用途", raw)
        assert seg.address_count == addresses
        assert seg.subnet_count == subnets
        assert seg.kind == kind

    @pytest.mark.parametrize("sep", ["-", "–", "—", "~"])
    def test_range_separators(self, sep: str) -> None:
        """真实数据用 ASCII `-`，兼容中文破折号与波浪号。"""
        seg = parse_segment("用途", f"172.30.1.0/24{sep}172.30.3.0/24")
        assert seg.subnet_count == 3

    def test_range_whitespace_tolerated(self) -> None:
        seg = parse_segment("用途", "  172.30.1.0/24 - 172.30.2.0/24  ")
        assert seg.subnet_count == 2
        assert seg.raw == "172.30.1.0/24 - 172.30.2.0/24"

    def test_start_end(self) -> None:
        seg = parse_segment("用途", "172.30.1.0/24-172.30.15.0/24")
        assert str(seg.start) == "172.30.1.0"
        assert str(seg.end) == "172.30.15.255"

    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "   ",
            "not-an-ip",
            "172.30.0.0/33",
            "172.30.1.0/24-172.30.15.0/25",  # 前缀不一致
            "172.30.15.0/24-172.30.1.0/24",  # 起点大于终点
        ],
    )
    def test_invalid_raises(self, raw: str) -> None:
        with pytest.raises(ValueError):
            parse_segment("用途", raw)


class TestParsePlan:
    """行序列解析：用途沿用 + 坏行隔离。"""

    def test_carry_forward_purpose(self) -> None:
        plan = parse_ip_plan(REAL_V13_ROWS)
        assert len(plan.segments) == 10
        assert plan.segments[1].purpose == "交换机互联地址"
        assert plan.segments[9].purpose == "租户浮动IP地址"
        assert plan.issues == ()

    def test_bad_row_isolated_as_issue(self) -> None:
        plan = parse_ip_plan(
            [("甲", "172.30.0.0/24"), ("乙", "垃圾"), ("丙", "172.30.1.0/24")]
        )
        assert len(plan.segments) == 2
        assert len(plan.issues) == 1
        assert "垃圾" in plan.issues[0]

    def test_blank_segment_skipped(self) -> None:
        plan = parse_ip_plan([("甲", "172.30.0.0/24"), ("乙", ""), ("", "  ")])
        assert len(plan.segments) == 1

    def test_empty_plan(self) -> None:
        plan = parse_ip_plan([])
        assert plan.segments == ()
        assert build_payload(plan)["totals"]["addresses"] == 0
        assert build_payload(plan)["utilization"]["supernet"] == ""


class TestOverlaps:
    """网段级重叠校验。"""

    def test_disjoint_real_data(self) -> None:
        plan = parse_ip_plan(REAL_V13_ROWS)
        assert find_overlaps(plan.segments) == ()

    def test_subnet_inside_supernet_detected(self) -> None:
        a = parse_segment("甲", "172.30.0.0/24")
        b = parse_segment("乙", "172.30.0.0/25")
        overlaps = find_overlaps((a, b))
        assert len(overlaps) == 1
        assert overlaps[0].example == "172.30.0.0/25"
        assert overlaps[0].shared == 1

    def test_range_overlap_counts_pairs(self) -> None:
        a = parse_segment("甲", "172.30.1.0/24-172.30.5.0/24")
        b = parse_segment("乙", "172.30.3.0/24-172.30.7.0/24")
        overlaps = find_overlaps((a, b))
        assert len(overlaps) == 1
        assert overlaps[0].shared == 3  # 3/4/5 三个 /24 重叠


class TestSupernet:
    """最小覆盖超网（使用率分母）。"""

    def test_real_data_supernet(self) -> None:
        plan = parse_ip_plan(REAL_V13_ROWS)
        sup = enclosing_supernet(plan.segments)
        assert str(sup) == "172.30.0.0/15"
        assert sup.num_addresses == 131072

    def test_single_segment(self) -> None:
        seg = parse_segment("甲", "10.0.0.0/8")
        assert str(enclosing_supernet((seg,))) == "10.0.0.0/8"

    def test_empty(self) -> None:
        assert enclosing_supernet(()) is None


class TestRoundTrip:
    """导出回写还原源表文本。"""

    def test_format_range(self) -> None:
        seg = parse_segment("甲", "172.30.1.0/24-172.30.15.0/24")
        assert format_segment(seg) == "172.30.1.0/24-172.30.15.0/24"

    def test_format_cidr(self) -> None:
        assert format_segment(parse_segment("甲", "172.31.0.0/16")) == "172.31.0.0/16"

    def test_to_rows_carry_forward(self) -> None:
        plan = parse_ip_plan(REAL_V13_ROWS)
        rows = to_rows(plan.segments)
        assert rows[0] == ("交换机互联地址", "172.30.0.0/24")
        assert rows[1] == ("", "172.30.100.0/24")
        assert rows[9] == ("", "172.31.0.0/16")
        # 回写后再解析，容量与用途数不变
        again = parse_ip_plan(rows)
        assert sum(s.address_count for s in again.segments) == 118016


class TestRealV13Payload:
    """对真实 V13 十行数据，逐项核对前端要展示的口径数字。"""

    @pytest.fixture()
    def payload(self) -> dict:
        return build_payload(parse_ip_plan(REAL_V13_ROWS))

    def test_totals(self, payload: dict) -> None:
        assert payload["totals"] == {
            "segments": 10,
            "purposes": 8,
            "subnets": 206,
            "addresses": 118016,
        }

    def test_utilization(self, payload: dict) -> None:
        u = payload["utilization"]
        assert u["supernet"] == "172.30.0.0/15"
        assert u["capacity"] == 131072
        assert u["planned"] == 118016
        assert u["ratio"] == 0.9004

    def test_no_conflicts(self, payload: dict) -> None:
        assert payload["conflicts"] == []
        assert payload["issues"] == []

    def test_by_purpose_sums_to_total(self, payload: dict) -> None:
        assert sum(p["addressCount"] for p in payload["byPurpose"]) == 118016
        assert len(payload["byPurpose"]) == 8

    def test_tenant_range_largest(self, payload: dict) -> None:
        tenant = next(p for p in payload["byPurpose"] if p["purpose"] == "租户浮动IP地址")
        # 123 个 /24（31488）+ 172.31.0.0/16（65536）
        assert tenant["addressCount"] == 31488 + 65536
        assert tenant["segmentCount"] == 2