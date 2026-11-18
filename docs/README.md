# SxDevOps 文档

面向当前 v2 系列，按使用任务查阅。首次运行从快速开始进入；升级已有环境先看版本升级说明。最近核对：2026-11-17。

## 安装与运维

| 文档 | 内容 |
| --- | --- |
| [快速开始](getting-started.md) | 本地开发、Compose 体验、首次管理员和演示数据 |
| [配置参考](configuration.md) | 配置优先级、数据库、Redis、密钥、初始化和 checkpoint |
| [部署与运维](deployment.md) | Compose / Podman、后台服务、备份、升级、回退和排障 |
| [产品页加载与静态压缩](frontend-performance.md) | 首屏图标按需注册、构建期 gzip/brotli 预压缩与 Nginx 接入 |
| [Kubernetes 部署](Kubernetes部署指南.md) | 镜像、Secret、PVC、worker 和集群部署 |
| [账号、RBAC 与安全](user-permission-security.md) | 授权规则、账号管理、敏感权限和公开演示边界 |
| [公开访客预览](public-preview.md) | `PUBLIC_PREVIEW_USERNAMES` 预览账号、前后端只读边界与验证 |
| [Google 安全浏览整改](google-safe-browsing-review.md) | 公开入口/登录跳转/Grafana 嵌入加固、CSP 与审核文案 |

## 功能使用

| 文档 | 内容 |
| --- | --- |
| [用户使用指南](用户使用文档.md) | AIOps、可观测性、事件中心和任务中心 |
| [CMDB 使用手册](CMDB使用手册.md) | 资产、采集、指标、拓扑、治理和成本 |
| [任务资源与 CMDB](task-resource-cmdb.md) | 显式接入、执行字段和资产生命周期 |
| [Kubernetes 工作台](K8s工作台与用户授权.md) | 资源操作、集群及命名空间授权、日志和终端 |
| [Docker 工作台](Docker工作台.md) | 环境、容器、镜像、日志和终端 |
| [网络监控使用手册](网络监控使用手册.md) | SNMP 设备纳管、凭据加密、NOC 态势与接口流量 |
| [WebShell 防护使用手册](WebShell防护使用手册.md) | 终端高危命令拦截、告警、规则管理与防护审计 |
| [vSphere 指标接入](vsphere-vm-prometheus-metrics.md) | Prometheus / node_exporter 真实运行指标 |

## IDC 上架规划与布线

vendored 子系统（原 IDCBoxLine，MPL-2.0），平台入口「数据机房 → IDC 上架布线」。域层公式与验收以 `planning/AGENTS.md` 与 `planning/backend/tests/` 为准。

| 文档 | 内容 |
| --- | --- |
| [规划子系统全貌](../planning/README.md) | 机柜/设备上架规划、2D/3D 图示、布线表生成、网段级 IP 规划 |
| [集成契约](../planning/INTEGRATION.md) | 进程模型、环境变量、认证权限、数据与验收接缝 |
| [真实数据复用评估](IDC上架布线-真实数据复用评估.md) | 信息港真实上架数据能否复用、场景满足度与自动生成边界 |

## 数据中心

| 文档 | 内容 |
| --- | --- |
| [数据中心设计与数字孪生](数据中心设计与数字孪生.md) | 数字孪生、平台项目编辑（CAD 内核）、独立工作台、项目库桥接与部署排障 |
| [IDC 上架布线](IDC上架布线-真实数据复用评估.md) | 机柜上架、布线规划与真实数据复用边界 |

## AIOps 与开发

| 文档 | 内容 |
| --- | --- |
| [AIOps 架构与运行机制](AIOps-LangGraph-试点说明.md) | LangGraph、工具、任务确认、恢复与执行审计 |
| [AI 机房建模](AIOps-AI机房建模.md) | 三维机房设计内的自然语言建模、AIOps 模型代理、审计与常见问题 |
| [问答类型与 Skills](AIOps-问答能力与Skills.md) | 六类入口、十三个内置 Skill、MCP 关联与兼容 |
| [处置效果验证](AIOps-处置效果验证.md) | 告警基线、实际任务、观察窗口与判定边界 |
| [前端主题](frontend-theme.md) | 三套主题、配色实现及适配验证 |
| [贡献指南](../CONTRIBUTING.md) | 开发规范、测试、文档维护和发布检查 |
| [安全问题反馈](../SECURITY.md) | 私密反馈渠道与披露流程 |

## 版本与素材

- [v2.0.3 更新说明](releases/v2.0.3.md)
- [v2.0.2 更新说明](releases/v2.0.2.md)
- [v2.0.1 更新说明](releases/v2.0.1.md)
- [v2.0.0 更新说明](releases/v2.0.0.md)
- [v2.0.0 升级说明](releases/v2.0.0-release-guide.md)
- [v2.0.0 验证记录与已知限制](releases/v2.0.0-validation.md)
- [产品截图及使用约定](screenshots/README.md)

## 维护约定

- 使用指南描述已实现行为，未来设想放在 Issue 或明确标注的提案中。
- 一个主题维护一份说明；版本验收集中在 `releases/`，不新增逐轮测试日记。
- 修改功能时同步更新对应手册、升级要求和文档入口，检查本地链接与中文编码。
- 保留产品页已引用的文档路径；标题与正文按当前版本维护。替换文件路径时同步修改全部调用方。
- 临时日志、个人规划、讨论稿、测试截图和真实连接配置不进入正式文档目录。

[返回项目首页](../README.md)
