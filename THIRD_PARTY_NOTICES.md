# 第三方组件许可

SXDevOps 自有代码使用 [MIT License](LICENSE)。依赖和容器中的系统组件保留各自许可，不能用项目 MIT 许可覆盖。

前端每次 `npm run build` 前从已安装的生产依赖生成完整许可和版权声明，随发行文件保存在 `/assets/third-party-notices.txt`。缺少许可元数据或声明文件会阻止构建。分发前端文件时应同时保留该文件。

`@vue/devtools-api 6.6.4` 的 npm 包未附许可文件，已从上游同版本标签补齐；`lodash-unified 1.0.3` 未提供独立许可文件或源码地址，已保留发布者声明的 MIT 许可、作者元数据及标准 MIT 全文。补充记录按精确版本维护在 `frontend/licenses/`，升级后重新核对。

Python 包附带的许可文件由 pip 安装在对应 `.dist-info` 目录，发行容器保留这些文件。缺失文件的包补充声明、来源和核对版本保存在 `licenses/python/`，随镜像复制到 `/app/licenses/python/`。其中四个 Alibaba Python 包未提供许可文件，补充材料明确区分发布者声明、标准 Apache-2.0 全文和未能恢复的上游 NOTICE。发行镜像还保留 `/usr/share/doc/` 等系统包版权声明，以及 `/app/LICENSE` 和本文件。重新打包、裁剪依赖时也必须保留相应声明。

当前依赖包含 Paramiko（LGPL-2.1）、Certifi（MPL-2.0）、orjson（MPL-2.0 AND (Apache-2.0 OR MIT)）和其他具有独立许可的组件。项目没有修改这些库；下游应保留动态替换能力、许可文本及上游源码获取方式。若修改或重新分发相关库，应按对应 LGPL / MPL 条款提供所需源码和修改说明。

- [Paramiko 源码和发行版](https://github.com/paramiko/paramiko)
- [Certifi 源码和发行版](https://github.com/certifi/python-certifi)
- [orjson 源码和发行版](https://github.com/ijl/orjson)
- [本轮依赖版本与许可清单](docs/releases/v2.0.0-dependency-licenses.json)

清单记录本地验证环境的依赖闭包，不代表未来 `>=` 约束解析出的全部版本。每次构建镜像须重新核对实际安装版本、发行文本、可选依赖和系统包；本轮清单不能替代新发行物的检查。

## Vendored 子系统：IDC 上架布线引擎（planning/）

`planning/` 目录整体引入自 NetMon-Agent-Platform（原独立项目 IDCBoxLine），遵循 **MPL-2.0**（文件级 copyleft），与项目其余部分的 MIT 许可互不影响。上游仓库未附 LICENSE 文件，`planning/LICENSE` 为 MPL-2.0 官方标准文本，依据上游 README 的许可声明适用。本地修改（认证接入、主题联动、构建配置）逐文件记录在 `planning/NOTICE.md`；对外分发时这些文件须以源码形式提供（MPL-2.0 §3），本仓库随源码分发即满足该要求。引擎 Python 依赖（FastAPI、SQLAlchemy、openpyxl 等）按 `planning/backend/pyproject.toml` 钉版安装，各自许可随 `.dist-info` 保留。


## 参考前端与素材（tools/dc-designer）

`tools/dc-designer` 是按用户要求对公开数据中心设计器前端进行的独立复刻，随包保留其界面文案、图标、几何常量、样例项目与 AI 指令 OpenAPI 契约，用于行为对照和本地/离线设计。该目录的素材与文案权利归原提供方；对外分发前须自行确认授权。复刻代码不改用其服务端，模型调用在平台内走 AIOps 代理。

`tools/dc-designer/lib/three` 为 three.js r185 的 MIT 许可构建，许可文本见上游 <https://github.com/mrdoob/three.js>；`tools/dc-viewer` 通过 npm 依赖使用同一库。
