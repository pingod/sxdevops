"""网段级 IP 规划的读取 / 投影 / 回写端到端（真实 V13 数据）。

## 这组用例守护的是什么

`domain/ipplan` 的纯函数已被 `tests/unit/test_ipplan.py` 覆盖，但**适配层接线**
没被证明过：真实 sheet 名是不是「IP地址段规划」、表头按名匹配能不能取到列、
读出来的 10 行喂进服务能不能得到 118016 地址 / 90.04% 使用率 / 0 冲突。
这里走 `read_ip_plan_rows → ipplan_payload → write_ip_plan_xlsx → 再读` 一整圈。

## 与 unit 用例的分工

unit 喂的是手写的 10 行字符串（快，绕过 openpyxl）。这里真的打开用户的 xlsx ——
如果源表改了 sheet 名或插了列，只有这里能发现。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not (
        Path(__file__).resolve().parents[3]
        / "信息港部署上架"
        / "V13(内部)甘肃信息港-设备上架规划-20260714.xlsx"
    ).exists(),
    reason="需要真实 V13 源文件（只在完整仓库里跑）",
)

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "backend"
SOURCE = ROOT / "信息港部署上架" / "V13(内部)甘肃信息港-设备上架规划-20260714.xlsx"


@pytest.fixture(scope="module")
def rows() -> list[tuple[str, str]]:
    import sys

    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    from idcbox.infrastructure.xlsx.ipplan_sheet import read_ip_plan_rows

    data, warnings = read_ip_plan_rows(SOURCE)
    assert warnings == ()
    return data


class TestReadRealSheet:
    """真实「IP地址段规划」表读出来必须是 10 行、用途留空原样保留。"""

    def test_row_count(self, rows: list[tuple[str, str]]) -> None:
        assert len(rows) == 10

    def test_first_and_carry_forward(self, rows: list[tuple[str, str]]) -> None:
        assert rows[0] == ("交换机互联地址", "172.30.0.0/24")
        assert rows[1] == ("", "172.30.100.0/24")
        assert rows[9] == ("", "172.31.0.0/16")

    def test_range_text_preserved(self, rows: list[tuple[str, str]]) -> None:
        assert rows[2] == ("服务器管理地址", "172.30.1.0/24-172.30.15.0/24")


class TestServicePayload:
    """服务投影必须复现真实数据的口径数字。"""

    @pytest.fixture(scope="class")
    def payload(self, rows: list[tuple[str, str]]) -> dict:
        from idcbox.application.services.ipplan import ipplan_payload

        return ipplan_payload(rows, source="V13 · IP地址段规划")

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
        assert u["ratio"] == 0.9004

    def test_no_conflicts_or_issues(self, payload: dict) -> None:
        assert payload["conflicts"] == []
        assert payload["issues"] == []

    def test_source_attached(self, payload: dict) -> None:
        assert payload["source"] == "V13 · IP地址段规划"

    def test_json_serializable(self, payload: dict) -> None:
        assert json.loads(json.dumps(payload)) == payload


class TestExportRoundTrip:
    """导出回写后再读，容量与用途数不变（同一份模型）。"""

    def test_round_trip(self, rows: list[tuple[str, str]], tmp_path: Path) -> None:
        from idcbox.application.services.ipplan import ipplan_export_rows, ipplan_payload
        from idcbox.infrastructure.xlsx.ipplan_sheet import (
            read_ip_plan_rows,
            write_ip_plan_xlsx,
        )

        out = tmp_path / "ipplan.xlsx"
        export_rows = ipplan_export_rows(rows)
        write_ip_plan_xlsx(export_rows, out)
        assert out.exists()

        again, warnings = read_ip_plan_rows(out)
        assert warnings == ()
        assert again == export_rows
        before = ipplan_payload(rows)
        after = ipplan_payload(again)
        assert after["totals"] == before["totals"]
        assert after["utilization"] == before["utilization"]


class TestMissingSheetGraceful:
    """没有 IP 规划表的项目不该让读取抛异常。"""

    def test_missing_sheet_returns_warning(self, tmp_path: Path) -> None:
        from openpyxl import Workbook

        from idcbox.infrastructure.xlsx.ipplan_sheet import read_ip_plan_rows

        wb = Workbook()
        wb.active.title = "别的表"
        path = tmp_path / "no_ip.xlsx"
        wb.save(path)
        data, warnings = read_ip_plan_rows(path)
        assert data == []
        assert len(warnings) == 1
        assert "IP地址段规划" in warnings[0]

    def test_header_by_name_not_position(self, tmp_path: Path) -> None:
        """插一列「备注」在最前面，按名匹配仍要取对列。"""
        from openpyxl import Workbook

        from idcbox.infrastructure.xlsx.ipplan_sheet import read_ip_plan_rows

        wb = Workbook()
        ws = wb.active
        ws.title = "IP地址段规划"
        ws.append(["备注", "应用范围", "IP地址段"])
        ws.append(["x", "交换机互联地址", "172.30.0.0/24"])
        ws.append(["y", "", "172.30.100.0/24"])
        path = tmp_path / "shifted.xlsx"
        wb.save(path)
        data, warnings = read_ip_plan_rows(path)
        assert warnings == ()
        assert data == [
            ("交换机互联地址", "172.30.0.0/24"),
            ("", "172.30.100.0/24"),
        ]


class TestApiEndpoint:
    """HTTP 端点：/api/ipplan 与 /api/ipplan/export。"""

    @pytest.fixture(scope="class")
    def client(self):
        import os
        import sys

        if str(BACKEND) not in sys.path:
            sys.path.insert(0, str(BACKEND))
        os.environ.setdefault("IDCBOX_SOURCE", str(SOURCE))
        from fastapi.testclient import TestClient

        from idcbox.api.main import create_app

        return TestClient(create_app())

    def test_ipplan_payload(self, client) -> None:
        r = client.get("/api/ipplan")
        assert r.status_code == 200
        body = r.json()
        assert body["totals"]["addresses"] == 118016
        assert body["utilization"]["ratio"] == 0.9004
        assert body["conflicts"] == []
        assert "IP地址段规划" in body["source"]

    def test_ipplan_json_serializable(self, client) -> None:
        body = client.get("/api/ipplan").json()
        assert json.loads(json.dumps(body)) == body

    def test_export_is_xlsx(self, client) -> None:
        r = client.get("/api/ipplan/export")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        assert "attachment" in r.headers["content-disposition"]
        # xlsx 是 zip 容器，魔数 PK\x03\x04
        assert r.content[:4] == b"PK\x03\x04"

    def test_export_round_trips_through_reader(self, client, tmp_path: Path) -> None:
        from idcbox.infrastructure.xlsx.ipplan_sheet import read_ip_plan_rows

        r = client.get("/api/ipplan/export")
        out = tmp_path / "download.xlsx"
        out.write_bytes(r.content)
        rows, warnings = read_ip_plan_rows(out)
        assert warnings == ()
        assert len(rows) == 10
        assert rows[0] == ("交换机互联地址", "172.30.0.0/24")