# 机房设计器（tools/dc-designer）

本地优先的 2D 机房 CAD 编辑器：16 类构件、工勘向导、属性面板、成排/POD、合规检查、
PNG/DXF/CSV 导出、文件打开/保存与草稿恢复；内嵌 3D 查看（实景/素模、编号、隔离、
管路视图、平滑接头、3D PNG），并通过“检视”入口复用 `tools/dc-viewer` 的巡检/步行/剖切等能力。

## 运行

```bash
cd tools/dc-designer
npm install
npm run dev          # http://127.0.0.1:5200/
npm run dev -- --host 0.0.0.0   # 可选
```

独立模式（本地文件/导出）：`http://127.0.0.1:5200/`
AI 工作台模式：`http://127.0.0.1:5200/?ai=1`
AI 代理模式：`?ai=1&aiProxy=1`（模型由父页面转发到 AIOps，服务端选提供商并写审计）
平台项目模式：`http://127.0.0.1:5200/?embed=1`（由平台 iframe 加载）

`predev` 会自动构建 `tools/dc-viewer` 并复制到 `public/inspect/`（首次需要其依赖，脚本会按需
`npm install`）。因此**无需另开查看器服务**，3D 中的“检视”即可直接使用。

生产构建：

```bash
npm run build        # 构建查看器 → public/inspect/ → vite build（自动打入 dist/inspect/）
npm run preview
```

## 功能

- 16 类构件工具（墙/门/柱/梁/格栅/桥架/液冷管/风口/窗/机柜/列头柜/配电箱/UPS/蓄电池/空调/灭火器）
- 选择/框选/多选/拖动推挤/回弹/Ctrl 拖动复制/旋转/删除/方向键微调/格式刷/对齐/等距
- 成排与通道 POD 批量生成、重排编号、原位替换、空位检测补插、通道宽联动
- 工勘向导 4 步、属性面板全字段、项目汇总、last-props 记忆
- 21 条合规检查 + 阈值配置 + 报告/CSV/Markdown；实时布局检查（重叠/越界红框）
- 撤销/重做（80 深）、草稿自动保存与恢复、UI 现场恢复
- 文件打开/保存（File System Access，句柄存 IndexedDB；不可用时回退下载/上传）
- 导出 PNG（完整平面图）、DXF（AC1009，按类型分图层）、CSV（工程量汇总 + 设备/管道明细）
- 内嵌 3D：WebGPU 优先（WebGL2 回退）、real/bim 双风格、编号浮标、隔离右键菜单、
  管路视图、平滑接头（管道/桥架圆弯，含统计与风险提示）、8192px 全景 PNG
- 语言：中文 / English（跟随浏览器，可切换并记忆）
- AI 建模：AIOps 代理模式（`aiProxy=1`）走平台默认提供商并写模型/操作审计；独立模式保留浏览器直连或本机代理
- 检视：3D 内“检视” → 嵌入只读查看器，复用巡检/步行/剖切/定位/显示/拆解
- AI 建模：默认不在设计器加载；通过 `?ai=1` 打开，平台内入口为 AIOps → AI 机房建模
- 平台项目模式（`?embed=1`）：postMessage 握手 `ready/dirty/save/error`，父页下发
  `load/new-room/request-save/saved/cancel/error`；项目库、版本与乐观锁由平台负责，
  设计器隐藏本地文件组与工勘向导。平台「三维机房设计」即使用此模式。

## 数据与 fixtures

`public/fixtures/`：

| 文件 | 内容 |
|---|---|
| `demo.json` | 55 对象：12000×9000 围墙 + 4 排×12 机柜 + 3 条通道 |
| `pipes.json` | demo + 桥架 + 液冷管（管路视图/圆弯/3D 检查用） |
| `all-types.json` | demo + 16 类构件各至少 1 个 |

重新生成：`npm run fixtures`。项目 JSON 为 `{ name, meta, objects[] }`。

## 校验

```bash
npm test             # node:test：fixtures / 清洗 / i18n 字典
npm run e2e          # Playwright：向导→POD→选择/撤销→检查→导出→3D→检视→AI→刷新恢复
npm run parity       # 与基准截图对比（1600×1000、zh、同 fixture）
```

`parity` 的基准截图在 `test/parity/ref/`；品牌区与顶栏属于刻意去标识化区域，对比时已屏蔽；
AI 面板已拆到 AIOps 并改为用户自配模型，不再参与设计器像素对比（见 `scripts/parity.mjs`）。差异图输出到 `test/parity/out/`。

## 说明

- 界面已去除第三方商标与产品名；标题、欢迎页与应用内品牌均为“机房设计器 / Data Hall Designer”。
- 不包含第三方云提交、在线更新与授权签发；相关入口已移除，其余本地能力不受影响。
- AI 建模默认不预置服务地址与模型，需在设置中填写 OpenAI 兼容接口与模型名；Key 只存本机浏览器。
- 中文/英文文案与几何常量按参考实现保留；对外分发前请自行确认素材与商标授权。
