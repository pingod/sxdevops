"""巡检项目录：巡检项只在这里声明一次，执行器与页面都读同一份定义。

threshold_config 结构固定：
- 数值型：{'warning': w, 'critical': c, 'unit': '%', 'comparison': 'gte'|'lte'}
- 布尔型：{'comparison': 'eq', 'expect': 'yes'|'no', 'unit': ''}
- 存在型：{'comparison': 'flag', 'unit': ''}
"""

SEVERITY_RANK = {'ok': 0, 'unknown': 1, 'warning': 2, 'critical': 3}

MIDDLEWARE_CI_TYPE_CODES = ('REDIS', 'MYSQL', 'ELASTICSEARCH')

HOST_ITEM_CODES = (
    'host.load', 'host.cpu', 'host.memory', 'host.swap', 'host.disk', 'host.inode',
    'host.clock', 'host.systemd_failed', 'host.reboot_required', 'host.ssh_failed_login',
    'host.exposed_port', 'host.log_error',
)
K8S_ITEM_CODES = (
    'k8s.node_ready', 'k8s.node_pressure', 'k8s.pod_restarts', 'k8s.pod_not_ready',
    'k8s.workload_available', 'k8s.capacity', 'k8s.pvc_unbound',
)
MIDDLEWARE_ITEM_CODES = (
    'mw.redis.memory', 'mw.redis.hit_rate', 'mw.redis.replication', 'mw.redis.persistence',
    'mw.redis.evicted',
    'mw.mysql.connections', 'mw.mysql.slow_query', 'mw.mysql.replication', 'mw.mysql.buffer_pool',
    'mw.es.health', 'mw.es.unassigned', 'mw.es.heap',
)

_EXPOSED_PORTS = '3306/6379/27017/9200/11211/2375'

BUILTIN_INSPECTION_ITEMS = [
    # ---------------- 主机 ----------------
    {
        'code': 'host.load',
        'name': '系统负载',
        'category': 'host',
        'description': '按 CPU 核数归一后的 1 分钟平均负载。',
        'weight': 10,
        'threshold_config': {'warning': 1.0, 'critical': 2.0, 'unit': '', 'comparison': 'gte'},
        'remediation': '定位高负载进程（top -H、pidstat），确认是否有异常批处理、死循环或 IO 等待；必要时扩容或限流。',
        'sort_order': 10,
    },
    {
        'code': 'host.cpu',
        'name': 'CPU 空闲率',
        'category': 'host',
        'description': 'top 采样的 CPU 空闲百分比。',
        'weight': 10,
        'threshold_config': {'warning': 20, 'critical': 10, 'unit': '%', 'comparison': 'lte'},
        'remediation': '确认 CPU 消耗 Top 进程，排查热点服务与异常循环；持续高占用时评估扩容或进程限额。',
        'sort_order': 20,
    },
    {
        'code': 'host.memory',
        'name': '内存使用率',
        'category': 'host',
        'description': 'free 计算的物理内存使用率。',
        'weight': 10,
        'threshold_config': {'warning': 85, 'critical': 95, 'unit': '%', 'comparison': 'gte'},
        'remediation': '排查内存增长进程与泄漏，检查缓存占用；必要时重启异常服务或扩容内存。',
        'sort_order': 30,
    },
    {
        'code': 'host.swap',
        'name': 'Swap 使用率',
        'category': 'host',
        'description': 'Swap 使用率；未启用 Swap 时记为未知。',
        'weight': 10,
        'threshold_config': {'warning': 50, 'critical': 80, 'unit': '%', 'comparison': 'gte'},
        'remediation': 'Swap 使用升高通常代表内存压力，需排查内存占用并评估内存扩容；避免长期依赖 Swap 运行。',
        'sort_order': 40,
    },
    {
        'code': 'host.disk',
        'name': '磁盘使用率',
        'category': 'host',
        'description': '本地文件系统使用率，取最差挂载点。',
        'weight': 10,
        'threshold_config': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
        'remediation': '清理日志与临时文件，检查大文件增长；评估扩容或迁移数据，并为关键分区配置告警。',
        'sort_order': 50,
    },
    {
        'code': 'host.inode',
        'name': 'Inode 使用率',
        'category': 'host',
        'description': '文件系统 Inode 使用率，取最差挂载点。',
        'weight': 10,
        'threshold_config': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
        'remediation': '定位小文件堆积目录（如 session、缓存、临时文件），清理过期文件并配置定期回收。',
        'sort_order': 60,
    },
    {
        'code': 'host.clock',
        'name': '时钟同步',
        'category': 'host',
        'description': 'systemd-timesyncd/chrony 报告的 NTP 同步状态。',
        'weight': 10,
        'threshold_config': {'comparison': 'eq', 'expect': 'no', 'unit': ''},
        'remediation': '检查 chronyd/ntpd 服务与上游 NTP 可达性，恢复时间同步，避免证书校验与分布式一致性异常。',
        'sort_order': 70,
    },
    {
        'code': 'host.systemd_failed',
        'name': '失败服务单元',
        'category': 'host',
        'description': 'systemctl --failed 统计的失败单元数量。',
        'weight': 10,
        'threshold_config': {'warning': 1, 'critical': 3, 'unit': '个', 'comparison': 'gte'},
        'remediation': '逐个查看 systemctl status 与 journalctl 日志，修复启动失败原因后重新启用单元。',
        'sort_order': 80,
    },
    {
        'code': 'host.reboot_required',
        'name': '待重启',
        'category': 'host',
        'description': '存在 /var/run/reboot-required 标记（内核或关键库更新后未重启）。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '安排维护窗口重启主机以应用内核与库更新，重启前确认业务已摘流或有多副本。',
        'sort_order': 90,
    },
    {
        'code': 'host.ssh_failed_login',
        'name': 'SSH 失败登录(24h)',
        'category': 'host',
        'description': '最近 24 小时 sshd 记录的失败密码次数。',
        'weight': 10,
        'threshold_config': {'warning': 10, 'critical': 50, 'unit': '次', 'comparison': 'gte'},
        'remediation': '确认是否为暴力破解，收敛来源 IP、禁用密码登录改用密钥，并考虑 fail2ban 或安全组白名单。',
        'sort_order': 100,
    },
    {
        'code': 'host.exposed_port',
        'name': '高危端口暴露',
        'category': 'host',
        'description': f'监听在 0.0.0.0/* 的数据库与中间件端口（{_EXPOSED_PORTS}）。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '将数据库与中间件端口改为仅监听内网或绑定 127.0.0.1，并通过安全组/防火墙限制访问来源。',
        'sort_order': 110,
    },
    {
        'code': 'host.log_error',
        'name': '系统错误日志(24h)',
        'category': 'host',
        'description': 'journalctl -p err 最近 24 小时的条数。',
        'weight': 10,
        'threshold_config': {'warning': 20, 'critical': 100, 'unit': '条', 'comparison': 'gte'},
        'remediation': '按单元聚合错误日志，定位反复报错的服务或硬件问题（磁盘、网卡、OOM）并处理根因。',
        'sort_order': 120,
    },
    # ---------------- K8s ----------------
    {
        'code': 'k8s.node_ready',
        'name': '节点就绪',
        'category': 'k8s',
        'description': '节点 Ready condition 是否全部为 True。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '检查 NotReady 节点的 kubelet、容器运行时与网络插件状态，确认资源压力与磁盘异常。',
        'sort_order': 210,
    },
    {
        'code': 'k8s.node_pressure',
        'name': '节点资源压力',
        'category': 'k8s',
        'description': '节点 MemoryPressure / DiskPressure / PIDPressure 是否被触发。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '清理节点磁盘与镜像缓存，限制超卖工作负载，必要时驱逐或扩容节点。',
        'sort_order': 220,
    },
    {
        'code': 'k8s.pod_restarts',
        'name': 'Pod 重启次数',
        'category': 'k8s',
        'description': '全集群容器重启次数合计。',
        'weight': 10,
        'threshold_config': {'warning': 5, 'critical': 20, 'unit': '次', 'comparison': 'gte'},
        'remediation': '定位重启最多的 Pod，查看 describe 事件与上次退出码，修复 OOM、探针失败或镜像问题。',
        'sort_order': 230,
    },
    {
        'code': 'k8s.pod_not_ready',
        'name': '异常 Pod',
        'category': 'k8s',
        'description': '非 Running/Succeeded 或容器未就绪的 Pod 数量。',
        'weight': 10,
        'threshold_config': {'warning': 1, 'critical': 5, 'unit': '个', 'comparison': 'gte'},
        'remediation': '按 Pending/CrashLoopBackOff/ImagePullBackOff 分类处理，确认调度资源、镜像仓库与配置挂载。',
        'sort_order': 240,
    },
    {
        'code': 'k8s.workload_available',
        'name': '工作负载可用副本',
        'category': 'k8s',
        'description': 'Deployment/StatefulSet 的就绪副本是否满足期望副本。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '检查滚动更新状态、资源配额与就绪探针，恢复副本数并确认 PDB 未阻塞调度。',
        'sort_order': 250,
    },
    {
        'code': 'k8s.capacity',
        'name': '集群容量水位',
        'category': 'k8s',
        'description': 'CPU/内存 requests 占 allocatable 的比例，取较高者。',
        'weight': 10,
        'threshold_config': {'warning': 70, 'critical': 85, 'unit': '%', 'comparison': 'gte'},
        'remediation': '核对 requests 是否虚高，清理闲置工作负载，规划节点扩容或调整调度策略。',
        'sort_order': 260,
    },
    {
        'code': 'k8s.pvc_unbound',
        'name': 'PVC 未绑定',
        'category': 'k8s',
        'description': 'phase 不是 Bound 的 PersistentVolumeClaim 数量。',
        'weight': 10,
        'threshold_config': {'warning': 1, 'unit': '个', 'comparison': 'gte'},
        'remediation': '确认 StorageClass、可用容量与访问模式是否匹配，处理 Pending 的 PV 绑定事件。',
        'sort_order': 270,
    },
    # ---------------- 中间件 ----------------
    {
        'code': 'mw.redis.memory',
        'name': 'Redis 内存使用率',
        'category': 'middleware',
        'description': 'used_memory / maxmemory。',
        'weight': 10,
        'threshold_config': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
        'remediation': '确认淘汰策略与 key 生命周期，清理无用大 key，评估扩容或分片。',
        'sort_order': 310,
    },
    {
        'code': 'mw.redis.hit_rate',
        'name': 'Redis 命中率',
        'category': 'middleware',
        'description': 'keyspace_hits / (hits + misses)。',
        'weight': 10,
        'threshold_config': {'warning': 90, 'critical': 80, 'unit': '%', 'comparison': 'lte'},
        'remediation': '排查缓存穿透与过期策略，补充空值缓存或调整 key 粒度与 TTL。',
        'sort_order': 320,
    },
    {
        'code': 'mw.redis.replication',
        'name': 'Redis 复制状态',
        'category': 'middleware',
        'description': '副本链路状态与主节点副本数量。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '恢复 master_link_status:up，检查网络与主节点 maxmemory 配置，确认副本数量满足高可用要求。',
        'sort_order': 330,
    },
    {
        'code': 'mw.redis.persistence',
        'name': 'Redis 持久化状态',
        'category': 'middleware',
        'description': 'RDB/AOF 最近一次落盘状态。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '检查磁盘空间与 fork 失败情况，修复 bgsave/bgrewrite 错误，必要时调整持久化策略。',
        'sort_order': 340,
    },
    {
        'code': 'mw.redis.evicted',
        'name': 'Redis 淘汰计数',
        'category': 'middleware',
        'description': '与上次巡检相比 evicted_keys 的增量。',
        'weight': 10,
        'threshold_config': {'warning': 1, 'unit': '次', 'comparison': 'gte'},
        'remediation': '淘汰说明内存已达上限，评估扩容或调整 maxmemory/淘汰策略，避免热点数据被逐出。',
        'sort_order': 350,
    },
    {
        'code': 'mw.mysql.connections',
        'name': 'MySQL 连接使用率',
        'category': 'middleware',
        'description': 'Threads_connected / max_connections。',
        'weight': 10,
        'threshold_config': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
        'remediation': '排查连接泄漏与慢事务，确认连接池配置，必要时提高 max_connections 或做读写分离。',
        'sort_order': 360,
    },
    {
        'code': 'mw.mysql.slow_query',
        'name': 'MySQL 慢查询(5m 增量)',
        'category': 'middleware',
        'description': '与上次巡检相比 Slow_queries 的增量。',
        'weight': 10,
        'threshold_config': {'warning': 10, 'critical': 100, 'unit': '条', 'comparison': 'gte'},
        'remediation': '开启并分析 slow log，补充索引、改写大查询，确认是否存在全表扫描与锁等待。',
        'sort_order': 370,
    },
    {
        'code': 'mw.mysql.replication',
        'name': 'MySQL 主从状态',
        'category': 'middleware',
        'description': 'SHOW SLAVE STATUS 的 IO/SQL 线程与延迟。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '恢复复制线程，检查网络与账号权限，处理主从延迟根因（大事务、单线程回放、IO 瓶颈）。',
        'sort_order': 380,
    },
    {
        'code': 'mw.mysql.buffer_pool',
        'name': 'InnoDB 缓冲池命中率',
        'category': 'middleware',
        'description': '1 - read_misses / read_requests。',
        'weight': 10,
        'threshold_config': {'warning': 95, 'critical': 90, 'unit': '%', 'comparison': 'lte'},
        'remediation': '评估 buffer_pool_size 与实例内存配比，减少全表扫描，热点数据尽量驻留内存。',
        'sort_order': 390,
    },
    {
        'code': 'mw.es.health',
        'name': 'ES 集群健康',
        'category': 'middleware',
        'description': '_cluster/health 的 status。',
        'weight': 10,
        'threshold_config': {'comparison': 'flag', 'unit': ''},
        'remediation': '处理未分配分片与副本不足，检查节点磁盘水位与集群脑裂风险。',
        'sort_order': 400,
    },
    {
        'code': 'mw.es.unassigned',
        'name': 'ES 未分配分片',
        'category': 'middleware',
        'description': '_cluster/health 的 unassigned_shards。',
        'weight': 10,
        'threshold_config': {'warning': 1, 'critical': 5, 'unit': '个', 'comparison': 'gte'},
        'remediation': '用 _cluster/allocation/explain 定位未分配原因，处理磁盘水位、节点离线或索引设置问题。',
        'sort_order': 410,
    },
    {
        'code': 'mw.es.heap',
        'name': 'ES JVM 堆使用率',
        'category': 'middleware',
        'description': '_nodes/stats/jvm 的 heap_used / heap_max。',
        'weight': 10,
        'threshold_config': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
        'remediation': '排查大聚合与字段膨胀，避免超过 75% 堆水位；必要时扩容或调整分片与 mapping。',
        'sort_order': 420,
    },
]

BUILTIN_ITEM_CODES = tuple(item['code'] for item in BUILTIN_INSPECTION_ITEMS)


def builtin_item_map():
    return {item['code']: item for item in BUILTIN_INSPECTION_ITEMS}


def seed_builtin_items(item_model=None):
    """幂等写入内置巡检项；迁移与测试共用。"""
    if item_model is None:
        from .models import InspectionItem as item_model
    for definition in BUILTIN_INSPECTION_ITEMS:
        defaults = {key: value for key, value in definition.items() if key != 'code'}
        defaults['is_builtin'] = True
        item_model.objects.update_or_create(code=definition['code'], defaults=defaults)
    return len(BUILTIN_INSPECTION_ITEMS)
