# 规划模块集成契约（SXDevOps）

本目录原为独立仓库 `IDCBoxLine`，后并入 NetMon-Agent-Platform（NAP），
现作为 SXDevOps 的 vendored 子系统运行（MPL-2.0，见 `NOTICE.md`）。
本文只记录**与 SXDevOps 主平台的接缝**；域层、公式与验收标准仍以
`AGENTS.md` 与 `backend/tests/` 为准。

## 进程模型

```
Browser
  └─ /datacenter/planning        Vue 路由 PlanningCenter（iframe 壳 + 引擎状态条）
       └─ /planning-app/         Django 托管的规划前端（Vite 产物，SPA fallback）
            └─ /api/planning/*   Django 认证反代（DRF Token + RBAC + 审计）
                 └─ Python 引擎（uvicorn + FastAPI，idcbox.api.main:create_app）
```

两种运行模式，由 `PLANNING_ENGINE_URL` 是否设置决定：

- **本地监管模式**（开发/单机）：`python manage.py planning_engine` 拉起并监管
  引擎子进程（就绪探针 90s、健康巡检 10s、连续 3 次失败杀掉重启、
  退避 1→30s、SIGINT 优雅关停最多等 5s）。引擎默认只绑定 `127.0.0.1`。
- **Compose 边车模式**（生产）：`planning-engine` 服务用同一镜像运行
  `manage.py planning_engine`（`PLANNING_BIND=0.0.0.0`，不对宿主机发布端口）；
  `sxdevops-app` 设 `PLANNING_ENGINE_URL=http://planning-engine:18001`，
  只做反代与静态托管，不监管进程。`planning_engine` 命令在远端模式下拒绝启动。

引擎不可用时：`/api/planning-status` 返回状态与原因，代理返回 503；
主平台其余功能不受影响。写操作（新建项目/保存意图/导入模型）额外记录
操作审计（module=planning, category=config）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PLANNING_ENABLED` | `true` | `false` 时完全跳过引擎 |
| `PLANNING_ENGINE_URL` | 空 | 设置后进入远端托管模式（如 `http://planning-engine:18001`），跳过本地发现 |
| `PLANNING_BIND` | `127.0.0.1` | 本地监管模式的监听地址；容器内用 `0.0.0.0` |
| `PLANNING_ROOT` | `<repo>/planning` | 引擎根目录 |
| `PLANNING_ENGINE_DIR` | `<root>/backend` | `idcbox` 包所在目录（子进程 cwd） |
| `PLANNING_PYTHON` | 自动：`backend/.venv` → 装了 fastapi 的当前解释器 | 解释器 |
| `PLANNING_PORT` | `18001` | 本地监管模式端口 |
| `PLANNING_DB` | `<repo>/backend/runtime/planning/idcbox.db` | 运行库；不存在时从种子库复制 |
| `PLANNING_STATIC_DIR` | `<root>/web/dist` | 前端产物目录 |

## 构建

```bash
# 规划前端（产物由 Django 直接托管，无需拷贝）
cd planning/web
pnpm install --frozen-lockfile
VITE_BASE=/planning-app/ VITE_API_BASE=/api/planning ./node_modules/.bin/vite build
```

Docker 镜像内由 `planning-web-builder` 阶段完成上述构建；引擎依赖按
`backend/pyproject.toml` 的 `[serve]` extras 钉版安装进镜像系统解释器。
本地开发在 `planning/backend` 建 `.venv` 并 `pip install -e ".[serve]"`。

## 数据

- 种子库：`planning/data/idcbox.db`（V13 / 信息港二期，含意图版本），只读随包分发。
- 运行库：默认 `backend/runtime/planning/idcbox.db`（gitignore）；
  Compose 中落在 `aiops_runtime` 卷，与平台运行数据同一备份策略。
- 运行时可写项目：`planning/projects/`（引擎会写 `models.json`），
  Compose 中由 `planning_projects` 命名卷承载，首次启动从镜像种子内容初始化。
- 源 Excel：`planning/信息港部署上架/`（只读，用于 `N/O` 几何与导出铁线）。
- 意图：`planning/projects/v13/intent*.json`；规则：`planning/rules/`。

## 认证与权限

- 前端 iframe 与主站同源，共享 localStorage：`sxdevops_token`（DRF Token）、
  `sxdevops-theme`（三主题联动，storage 事件免刷新切换）。
- 权限码：`datacenter.planning.view`（读/状态）、`datacenter.planning.manage`（写）。
  后端反代强制校验，前端菜单/路由隐藏只是镜像。
- 引擎自身的 `/api/*` 不做认证，安全边界完全由 Django 反代承担，
  因此引擎端口绝不应对宿主机或公网暴露。

## 验收

```bash
cd planning/backend
env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m pytest tests/ -p no:warnings
env -u PYTHONHOME -u PYTHONPATH .venv/bin/python scripts/verify_export.py   # 必须 0 格差异
env -u PYTHONHOME -u PYTHONPATH .venv/bin/lint-imports                      # 5 条架构契约
cd ../web && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit
```

主平台侧（无宿主机 Django 环境时用一次性容器）：

```bash
docker run --rm --entrypoint python -e DATABASE_ENGINE=sqlite \
  -v "$PWD/backend:/app/backend" -v "$PWD/planning:/app/planning:ro" \
  -w /app/backend sxdevops:latest manage.py test planning rbac.test_permission_surface

curl -s -H "Authorization: Token <key>" http://127.0.0.1:8000/api/planning-status
curl -s -H "Authorization: Token <key>" http://127.0.0.1:8000/api/planning/api/meta
```