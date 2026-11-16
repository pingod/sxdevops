# 第三方组件声明：IDC 上架布线引擎（planning/）

本目录是 vendored 子系统，原为独立项目 **IDCBoxLine**，后并入
[NetMon-Agent-Platform](https://github.com/aiyiyi121/NetMon-Agent-Platform)（下称 NAP）
作为其内置规划模块。SXDevOps 于 2026-11-12 从 NAP 本地仓库整体引入。

## 许可

- NAP 根 README 明确声明项目遵循 **Mozilla Public License 2.0 (MPL-2.0)**；
  引入时上游仓库未附带 LICENSE 文件，本目录 `LICENSE` 为 MPL-2.0 官方标准文本
  （取自 mozilla.org），依据上游 README 的许可声明适用。
- 本目录内文件保持 MPL-2.0；对其中文件的修改必须在文件内或本声明中记录，
  且对外分发时这些文件须以源码形式提供（MPL-2.0 §3）。
- 目录外 SXDevOps 自有代码仍为 MIT，不受本目录许可影响（MPL 为文件级 copyleft）。

## 本地修改记录

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `web/src/api/client.ts` | 认证头从 `Bearer <NAP JWT>`（localStorage `token`）改为 `Token <DRF key>`（localStorage `sxdevops_token`）；401 时清理 SXDevOps 会话键并跳转顶层 `/login` | 接入 SXDevOps DRF Token 认证与 RBAC |
| `web/src/App.tsx` | 嵌入模式下读取平台主题键 `sxdevops-theme` 并监听 storage 事件；`light` 追加 `is-light` 类，`charcoal`/`dark` 使用原生暗色；页脚改为“平台内置引擎” | 与平台三主题联动，免刷新切换 |
| `web/src/styles.css` | 嵌入样式拆分为 `is-embedded`（布局）与 `is-embedded.is-light`（浅色覆盖）两层 | 原嵌入块强制浅色，拆分后炭灰/深蓝灰走原生暗色配色 |
| `web/vite.config.ts` | 注释与默认代理目标改为 SXDevOps（Django 反代 `/api/planning`）；构建 base 由 `VITE_BASE` 注入 | 构建产物挂到 `/planning-app/` |
| `web/pnpm-workspace.yaml` | `allowBuilds.esbuild` 占位文本补为 `true` | pnpm 11 冻结安装对未批准的构建脚本报错，Docker 构建无法通过 |
| `INTEGRATION.md` | 重写为 SXDevOps 集成契约 | 进程模型由 Go 监管改为 Django 监管/Compose 服务 |

其余文件与上游一致。引擎域层（`backend/idcbox/domain/`）的公式口径与
黄金向量（`shared/golden/`）不得擅改；改动必须通过 `backend/tests/` 全量用例
与 `backend/scripts/verify_export.py` 逐格导出铁线（0 格差异）。

## 数据资产

- `data/idcbox.db`：种子项目库（V13 / 信息港二期演示项目），只读随包分发；
  运行时库由平台监管进程复制到 `backend/runtime/planning/idcbox.db`，不改动种子。
- `信息港部署上架/`：客户源 Excel（只读），用于几何解析与导出铁线回归。