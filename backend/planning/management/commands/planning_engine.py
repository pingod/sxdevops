"""监管 IDC 上架布线引擎子进程。

用法：
    python manage.py planning_engine           # 前台监管（Compose / 本地开发）
    python manage.py planning_engine --check   # 只校验配置与依赖，不启动

引擎默认只监听 127.0.0.1（PLANNING_BIND 可改绑容器接口，Compose 内使用，
不对宿主机暴露端口）；对外访问一律走 /api/planning/ 的 RBAC 认证反代。
设置 PLANNING_ENGINE_URL 后引擎由远端容器托管，本命令拒绝重复监管。
"""
import logging
import signal
import sys

from django.core.management.base import BaseCommand

from planning.config import load_config
from planning.supervisor import EngineSupervisor, probe_health

logger = logging.getLogger('planning')


class Command(BaseCommand):
    help = '监管 IDC 上架布线引擎（发现/启动/健康检查/退避重启/优雅关停）'

    def add_arguments(self, parser):
        parser.add_argument('--check', action='store_true', help='只校验配置，不启动引擎')

    def handle(self, *args, **options):
        logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
        cfg = load_config()
        if not cfg.enabled:
            self.stdout.write('规划模块已禁用（PLANNING_ENABLED=false）')
            return
        if cfg.error:
            self.stderr.write(f'规划引擎配置错误：{cfg.error}')
            sys.exit(1)
        if options['check']:
            self.stdout.write(f'引擎地址: {cfg.base_url}')
            self.stdout.write(f'引擎目录: {cfg.root}')
            if cfg.remote_url:
                self.stdout.write('模式: 远端托管（PLANNING_ENGINE_URL）')
            else:
                self.stdout.write(f'解释器: {cfg.python}')
                self.stdout.write(f'监听: {cfg.bind}:{cfg.port}')
            self.stdout.write(f'运行库: {cfg.db_path}')
            ok, detail = probe_health(cfg)
            self.stdout.write(f'引擎在线: {"是" if ok else "否（' + detail + '）"}')
            return
        if cfg.remote_url:
            self.stderr.write(f'PLANNING_ENGINE_URL 已指向 {cfg.remote_url}，引擎由远端托管，本进程不做监管。')
            sys.exit(1)

        supervisor = EngineSupervisor(cfg)
        signal.signal(signal.SIGINT, supervisor.stop)
        signal.signal(signal.SIGTERM, supervisor.stop)
        self.stdout.write(f'启动规划引擎监管（{cfg.base_url}，库 {cfg.db_path}）')
        try:
            supervisor.run()
        finally:
            supervisor.stop()
        self.stdout.write('规划引擎已停止')