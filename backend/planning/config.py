"""IDC 上架布线引擎的运行配置与发现逻辑。

引擎是 vendored 的 Python FastAPI 子系统（仓库根 `planning/`，MPL-2.0，
见 planning/NOTICE.md）。平台侧只做三件事：进程监管、认证反向代理、
前端静态托管；引擎本体不改动域层。

所有配置项均可用环境变量覆盖，与 NAP 的 PLANNING_* 命名保持一致，
便于两侧部署文档互相参照。
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 18001


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {'1', 'true', 'yes', 'on'}


@dataclass(frozen=True)
class EngineConfig:
    enabled: bool
    root: Path | None
    engine_dir: Path | None
    python: str | None
    port: int
    db_path: Path
    static_dir: Path | None
    error: str = ''
    bind: str = '127.0.0.1'
    remote_url: str = ''

    @property
    def base_url(self) -> str:
        return self.remote_url or f'http://127.0.0.1:{self.port}'

    @property
    def ready(self) -> bool:
        return self.enabled and not self.error and (self.python is not None or bool(self.remote_url))


def _find_python(engine_dir: Path) -> str | None:
    venv_candidates = [
        engine_dir / '.venv' / 'bin' / 'python',
        engine_dir / '.venv' / 'Scripts' / 'python.exe',
    ]
    for candidate in venv_candidates:
        if candidate.is_file():
            return str(candidate)
    # 容器镜像把引擎依赖装进系统解释器；本地开发若主环境恰好装了
    # fastapi 也允许直接用，但优先独立 venv，避免依赖集互相污染。
    if importlib.util.find_spec('fastapi') is not None:
        return sys.executable
    return None


def load_config() -> EngineConfig:
    enabled = _env_bool('PLANNING_ENABLED', True)
    port_raw = os.environ.get('PLANNING_PORT', '').strip()
    try:
        port = int(port_raw) if port_raw else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    db_default = REPO_ROOT / 'backend' / 'runtime' / 'planning' / 'idcbox.db'
    db_path = Path(os.environ.get('PLANNING_DB') or db_default)
    bind = os.environ.get('PLANNING_BIND', '').strip() or '127.0.0.1'
    remote_url = os.environ.get('PLANNING_ENGINE_URL', '').strip().rstrip('/')

    if not enabled:
        return EngineConfig(False, None, None, None, port, db_path, None, bind=bind)

    root = Path(os.environ.get('PLANNING_ROOT') or REPO_ROOT / 'planning')
    engine_dir = Path(os.environ.get('PLANNING_ENGINE_DIR') or root / 'backend')
    static_dir = Path(os.environ.get('PLANNING_STATIC_DIR') or root / 'web' / 'dist')

    if remote_url:
        # Compose 边车模式：引擎由 planning-engine 容器托管，本进程只做
        # 反代与静态托管，不做本地源码/解释器发现，也不监管进程。
        return EngineConfig(True, root, engine_dir, None, port, db_path, static_dir,
                            bind=bind, remote_url=remote_url)

    if not (engine_dir / 'idcbox' / 'api' / 'main.py').is_file():
        return EngineConfig(True, root, engine_dir, None, port, db_path, static_dir,
                            error=f'未找到规划引擎源码: {engine_dir / "idcbox"}', bind=bind)

    python = os.environ.get('PLANNING_PYTHON') or _find_python(engine_dir)
    if not python:
        return EngineConfig(True, root, engine_dir, None, port, db_path, static_dir,
                            error='未找到可用 Python 解释器（请在 planning/backend 创建 .venv '
                                  '并安装 -e ".[infra,api]"，或用 PLANNING_PYTHON 指定）', bind=bind)
    return EngineConfig(True, root, engine_dir, python, port, db_path, static_dir, bind=bind)


def ensure_database(cfg: EngineConfig) -> None:
    """首次运行把随包种子库复制为独立运行库，不改动 vendored 种子。"""
    if cfg.db_path.exists() or cfg.root is None:
        return
    seed = cfg.root / 'data' / 'idcbox.db'
    if not seed.is_file():
        return  # 没有种子也能启动，引擎会自建空库
    cfg.db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg.db_path.with_suffix('.db.tmp')
    shutil.copyfile(seed, tmp)
    tmp.replace(cfg.db_path)