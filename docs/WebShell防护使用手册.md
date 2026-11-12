# WebShell 防护使用手册

WebShell 防护对主机 SSH、Docker 容器、K8s 集群三类浏览器终端做高危命令拦截、告警与审计。入口「安全中心 → WebShell 防护」（`/security-center/webshell`）。

## 工作原理

终端输入是逐字符流。守卫（`backend/ops/webshell_guard.py`）从按键流还原当前 shell 命令行，在**回车提交那一刻**按规则判定：

- 字符照常转发，保证回显即时；
- 命中**拦截**规则：不转发行尾回车，改向远端发送 `Ctrl+U` 清掉已输入命令，使其永不执行，并在终端回显红色拦截提示；
- 命中**告警**规则：放行命令，回显黄色告警提示；
- 命中**仅审计**规则：放行，只记录。

所有命中事件与会话打开/关闭写入事件中心（module=`ops`，category=`security`，action 以 `webshell_` 开头），可在「防护审计」页按类型筛选。

### 已知边界

- 只识别 shell 命令行；vim/top 等全屏交互程序内的按键不参与判定，规则应写得具体以避免误伤。
- Tab 补全、方向键调出的历史命令不在按键流中，无法还原，属尽力而为（与 JumpServer 等同类实现一致）。

## 权限

| 权限码 | 说明 |
| --- | --- |
| `ops.webshell.rule.view` | 查看规则与防护审计、命令测试 |
| `ops.webshell.rule.manage` | 新建/编辑/启停/删除规则 |

平台管理员、运维管理员拥有管理权限；审计员拥有查看权限。终端访问仍由原有 `ops.host.terminal` / `ops.docker.exec` / `ops.k8s.terminal` 控制，守卫在其之上叠加。

## 内置规则

迁移 `ops/0062_seed_webshell_rules.py` 内置 10 条规则：删除根目录、格式化磁盘、dd 写裸设备、重定向写裸设备、Fork 炸弹（拦截）；关机重启、清空防火墙、根目录权限放开、递归改属主根目录（告警）；清空命令历史（仅审计）。内置规则可停用、可调整动作，但不可删除。

## 规则管理

- 「拦截规则」页：新建/编辑规则（名称、Python 正则、动作、级别、优先级、启停），优先级小者优先匹配。
- 命令测试：输入命令即时查看命中的规则与动作，不下发任何终端。
- 「防护审计」页：按事件类型（拦截/告警/审计/打开/关闭）筛选，含命令、操作人、资源。

## 主要 API

| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/webshell-rules/` | 规则列表与创建 |
| `PUT/PATCH/DELETE /api/webshell-rules/{id}/` | 规则维护（内置不可删） |
| `POST /api/webshell-rules/test/` | 命令命中测试 `{command}` |
| `GET /api/webshell-rules/audit/?action=webshell_block` | 防护审计（分页） |

## 验收

```bash
cd backend && python manage.py test ops.test_webshell_guard
```

真实链路验收：起一个 SSH 目标主机纳管后，浏览器打开 WebShell 输入 `rm -rf /`，应看到红色拦截提示且命令未执行；防护审计页出现对应拦截记录。