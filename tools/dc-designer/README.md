# DCDesigner · 独立复刻（tools/dc-designer）

对 https://www.nvisual.com/dcdesigner/ 的 1:1 独立复刻：本地优先的 2D 机房 CAD 编辑器，
内嵌 3D 查看（实景 / 素模、编号、管路视图、平滑接头、隔离、3D PNG），并按要求把
`tools/dc-viewer`（DCExplorer 只读查看器）作为 union 检视入口接入。

## 运行

```bash
cd tools/dc-designer
npm install
npm run dev          # http://127.0.0.1:5200/
```

3D「检视」按钮需要查看器服务：

```bash
npm run dev:inspect  # 另一终端；启动 tools/dc-viewer 于 5199
```

生产构建会把查看器一并构建并复制到 `dist/inspect/`：

```bash
npm run build        # vite build + scripts/build-inspect.mjs
npm run preview
```

## 已实现的功能面

- 16 类构件工具（墙/门/柱/梁/格栅/桥架/液冷管/风口/窗/机柜/列头柜/配电箱/UPS/蓄电池/空调/灭火器）
- 选择/框选/多选/拖动推挤/回弹/Ctrl 拖动复制/旋转/删除/方向键微调/格式刷/对齐/等距
- 成排与通道 POD 批量生成、重排编号、原位替换、空位检测补插、通道宽联动
- 工勘向导 4 步、属性面板全字段、项目汇总、last-props 记忆
- 21 条合规检查 + 阈值配置 + 报告/CSV/Markdown；实时布局检查（重叠/越界红框）
- 撤销/重做（80 深）、草稿自动保存与恢复、UI 现场恢复
- 文件打开/保存（File System Access，句柄存 IndexedDB；不可用时回退下载/上传）
- 导出 PNG（完整平面图）、DXF（AC1009，按类型分图层）、CSV（工程量汇总 + 设备/管道明细）
- 内嵌 3D：WebGPU 优先（WebGL2 回退）、real/bim 双风格、编号浮标、隔离右键菜单、
  `管路视图`、`平滑接头`（管道/桥架圆弯，含统计与风险提示）、8192px 全景 PNG
- 语言：中文 / English（跟随浏览器，可切换并记忆）
- AI 建模：OpenAI 兼容端点（本机 `/api/ai` 代理可选，否则浏览器直连；Key 只存本机浏览器）
- 可选服务契约：`/api/license`、`version.json` + `latest.js`、`/api/nvisual`、`/api/agent/*`；
  无服务时静默降级
- union 检视：3D 内「检视」→ iframe 嵌入 DCExplorer，复用巡检/步行/剖切/定位/显示/拆解

## 数据与 fixtures

`public/fixtures/`：

| 文件 | 内容 |
|---|---|
| `demo.json` | 55 对象：12000×9000 围墙 + 4 排×12 机柜 + 3 条通道（与参考站向导同参数） |
| `pipes.json` | demo + 桥架 + 液冷管（管路视图/圆弯/3D 检查用） |
| `all-types.json` | demo + 16 类构件各至少 1 个 |

重新生成：`npm run fixtures`。项目 JSON 为 `{ name, meta, objects[] }`，与参考站互通。

## 校验

```bash
npm test             # node:test：fixtures / 清洗 / i18n 字典
npm run e2e          # Playwright：向导→POD→选择/撤销→检查→导出→3D→检视→AI→刷新恢复
npm run parity       # 参考站 vs 本地截图（1600×1000、zh、同 fixture）
npm run parity -- --update-ref   # 重录参考截图（需外网）
```

`parity` 阈值：2D 状态 3%，3D 状态 6%（3D 右下角「检视」按钮区域屏蔽）；差异图输出到
`test/parity/out/`。

## 与参考站的已知、刻意差异

- 仅保留中文 / English（参考站另有 ar/es）；语言下拉只显示 中 / EN。
- 3D 浮动按钮新增「检视」（union 要求）；其余 3D 按钮布局与行为不变。
- 不实现 nVisual 私有云（云项目库、Submit 服务端、授权签发）；对应 UI/契约保留，无服务时降级。
- 版本清单 `public/version.json` 固定为 `1.16.0`，避免复刻站被参考站发布清单提示升级。
- 存储键使用本应用命名空间（`dcd:` 等）；不迁移参考站既有本机数据。

## 来源与授权说明

本目录是对参考站前端行为与公开资源的研究性复刻，用于用户指定的 1:1 对照/演示场景。
中文/英文界面文案、图标与几何常量来自参考站公开页面；`dc-viewer` 为本仓库此前的独立复刻。
对外分发前请自行确认参考站素材与商标的使用授权。
