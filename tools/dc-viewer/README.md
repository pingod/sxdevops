# DCDesigner 3D 查看器（独立复刻）

只读三维机房查看器：加载 `?src=<项目 JSON>` 渲染机柜、通道、桥架、空调、围护等对象，
提供视角、显示、剖切、定位、漫游、拆解六类工具。纯静态前端（Vite + three.js r185 WebGPU，
不支持 WebGPU 时自动回退 WebGL2），无后端依赖。

## 运行

```bash
cd tools/dc-viewer
npm install
npm run dev            # http://127.0.0.1:5199/?src=samples/room.json
```

构建静态产物（可放任意静态服务器）：

```bash
npm run build
npm run preview
```

样例数据：`public/samples/room.json`（参考样例）与 `public/samples/room-b.json`
（方案对比 B：A01 改色、A02 右移 60mm、删除 A03、H 排新增 H20）。

## 功能

- 视角：全景轨道 / 俯视平面 / 轴测四角 / 四向正交立面 / 业务视点（入口、四角、通道、设备区）/ 对象聚焦。
- 显示：分类显隐、实景与白模线稿、围护透视、柜号标签、方案 A/B 对比。
- 剖切（互斥）：真裁剪（切穿几何、不封口）、盒体剖切、高度过滤、侧别过滤。
- 定位：搜索（精确/前缀，最多 10 条）、聚焦（不穿墙/穿柜）、隔离（变暗 / 隐藏其余）。
- 漫游：自动巡检（全场环线 / 单排 / 巡检线）、手动步行（WASD、拖拽看向、触屏摇杆）、互相接管。
- 拆解：演示档 / 评审档两档位移，展开与拼装复原。

## 快捷键

| 键 | 作用 |
|---|---|
| `V` | 视角抽屉 |
| `/` | 搜索定位 |
| `T` / `I` | 俯视 / 轴测（`I` 轮换四角） |
| `[` `]` | 上一个 / 下一个业务视点 |
| `C` | 剖切开 / 关 |
| `X` | 围护透视 |
| `F` | 聚焦选中对象 |
| `L` | 柜号标签 |
| `E` | 展开 / 拼装 |
| `K` | 白模线稿 |
| `G` | 手动步行 |
| `空格` | 巡检暂停 / 继续 |
| `Esc` | 逐级退出（步行 → 抽屉 → 效果 → 视图 → 选中） |

## URL 参数

`src`、`src2` + `ab=a|b`、`view`（orbit/top/iso/iso-se…/front/back/left/right/业务视点 id）、
`focus`、`section=height|side|clip|box` + `cut` / `side*` / `clip*` / `box*`、`route`、
`xray=0|1`、`hide=`（分类 id 列表）、`ui=0`、`debug=wire`、`style=lineart`、
`explode=review`、`renderer=webgl|webgpu`、`bright`。默认值不写入地址；状态变化只做
`history.replaceState`。

## 三维机房设计器

同一套构建产物里还有编辑态：`design.html`（平台页面 `/datacenter/twin-design` 以 iframe 嵌入）。

- 构件库：机柜、墙体、桥架、空调、PDU、UPS、立柱；点放或拖线，墙体/桥架自动正交吸附。
- 快速布局：按数量/间距/方向批量生成机柜排。
- 编辑：拖动改平面位置（100mm 吸附，按 Alt 取消）、`R` 旋转 90°、`Del` 删除、`Ctrl+D` 复制、
  `Ctrl+Z` / `Ctrl+Y` 撤销重做（整份项目快照，栈深 80）。
- 围护默认半透明，避免墙挡住柜体；顶部可切回实心。
- 保存：嵌入时把项目 JSON 通过 `postMessage` 交给父页面写入项目库（父页面持有令牌），
  独立打开时导出 JSON 文件。

消息约定（父页面 ⇄ 设计器）：

| 方向 | 消息 |
|---|---|
| 设计器 → 父 | `ready`、`dirty {dirty}`、`save {project}` |
| 父 → 设计器 | `load {project, id?, name?, force?}`、`new-room {name,width,depth,height,floorHeight}`、`request-save`、`saved {id,name}`、`error {message}` |

```bash
npm run dev   # http://127.0.0.1:5199/design.html
```

## 校验

```bash
npm test               # 纯逻辑单测（node:test）
npm run parity         # 参考站截图逐像素对比（阈值 3%，需网络与 Chrome）
node scripts/parity.mjs --update-ref   # 重录参考基准
```

`test/parity/ref/` 保存参考基准截图；`test/parity/out/` 是差异输出（gitignored）。

## 说明

- 场景数据单位 mm，场景单位 m；`x3 = x/1000`、`z3 = -y/1000`（北 = -Z）。
- 每个数据对象一个 Three Group，合并只在对象内部进行，保留拾取/隔离/爆炸/线稿粒度。
- `window.__dcxd` 提供与调试/自动化对齐的自检接口（`info()`、`views()`、`section()`、
  `tour()`、`walk()`、`selection()`、`bench()` 等）。
- 本目录不包含参考站的任何源码；样例数据与参考截图仅用于回归比对。
