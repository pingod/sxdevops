# AIOps：AI 机房建模

`AIOps → AI 机房建模` 用自然语言生成或修改机房平面。模型只负责理解、换算和规划；几何、编号、推挤、通道联动和检查由设计器指令层执行。

## 入口与前提

- 入口：`AIOps → AI 机房建模`。
- 权限：`aiops.chat.view`。
- 模型：在 `AIOps → 智能体配置 → 模型提供商` 中配置一个已启用、连接测试通过的默认提供商。没有可用提供商时，代理返回 503。
- 数据库：需要执行 `aiops.0030_aiopsmodelinvocation_modeling_purpose` 迁移。

页面 iframe 为 `/dc-designer-app/?ai=1&noWelcome=1&lang=zh-CN&aiProxy=1`。设计器打开 AI 面板，模型调用交由父页面转发。

## 调用链

```text
设计器 AI 面板
  → postMessage {source:"dc-designer", type:"ai-chat", requestId, payload}
AIOps 页面（带登录态）
  → POST /api/aiops/modeling/chat/
AIOps 服务端
  → 默认模型提供商（Key 不出服务端）
  → AIOpsModelInvocation + EventWall 审计
  → 响应回传页面 → 设计器
```

设计器不再要求浏览器填写 API Key、Base URL 或模型名；设置区只显示代理说明。独立工作台（`?ai=1` 且无 `aiProxy=1`）仍保留本机直连/本机代理模式，用于离线场景。

## 代理约束

- 只接受 `system / user / assistant` 消息，最多 80 条、20 万字符。
- 模型、地址、Key 由服务端配置决定，客户端不能覆盖。
- `max_tokens` 受提供商配置上限约束。
- 附件中的图片按多模态内容转发；模型不支持视觉时沿用既有降级逻辑。
- 指令契约随设计器发布：`/dc-designer-app/api/agent/openapi.json`，不依赖本机 `/api/agent` 服务。

## 审计

每次代理调用写两层记录：

| 审计 | 内容 |
| --- | --- |
| AIOps 模型调用 | 提供商、实际模型、状态、耗时、Token、预估费用；`purpose=modeling` |
| 操作审计（EventWall） | `module=aiops`、`action=modeling_chat`；成功/失败、提供商、模型、Token |

在 `AIOps → 智能体审计` 的模型调用与操作记录中查看。失败调用同样留痕，便于定位提供商、权限或上游异常。

## 常见问题

- **503 / 未配置提供商**：先在智能体配置中启用并测试默认提供商；检查迁移是否执行。
- **指令契约不可用**：确认镜像包含 `tools/dc-designer/dist/api/agent/openapi.json`，页面无缓存旧产物。
- **发送后无响应**：检查 AIOps 页面是否被关闭、登录态是否过期，以及浏览器网络面板中 `/api/aiops/modeling/chat/` 的状态。
- **独立窗口仍要求 Key**：独立模式不走平台代理，这是预期行为；需要代理时从 `AIOps → AI 机房建模` 进入。

## 验证

- AI 代理成功/失败路径在 mock 模型响应下验证通过。
- 设计器 e2e 覆盖 AI 默认隐藏、AIOps 模式自动打开。
- 后端新增 `test_modeling_proxy.py`（权限、成功审计、失败审计）；部署后应执行迁移并检查审计记录。
