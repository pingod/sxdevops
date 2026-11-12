"""WebShell 高危命令拦截与审计。

终端输入是逐字符流：本模块从按键流里还原「当前 shell 命令行」，
在回车提交那一刻按规则判定。字符照常转发以保证回显即时；命中拦截规则时
不转发行尾回车，改为向远端发送 Ctrl+U 清掉已输入的命令，使其永不执行。

已知边界（与 JumpServer 等同类实现一致）：
- 只识别 shell 命令行；vim/top 等全屏交互程序里的按键不参与判定，
  规则应写得足够具体以避免误伤。
- Tab 补全、方向键调出的历史命令不在按键流里，无法还原，属尽力而为。
"""
import logging
import re

logger = logging.getLogger(__name__)

ACTION_BLOCK = 'block'
ACTION_WARN = 'warn'
ACTION_AUDIT = 'audit'

MAX_COMMAND_LENGTH = 4096


class WebShellGuard:
    """逐字符处理终端输入，返回 (应转发数据, 命中事件列表)。"""

    def __init__(self, rules):
        # rules: [(rule_instance, compiled_pattern)]，按优先级排序
        self.rules = rules
        self.buffer = ''
        self._escape = False

    def match(self, command):
        for rule, pattern in self.rules:
            if pattern.search(command):
                return rule
        return None

    def process(self, data):
        forward = []
        events = []
        for char in data:
            if self._escape:
                forward.append(char)
                if char.isalpha() or char == '~':
                    self._escape = False
                continue
            if char == '\x1b':
                self._escape = True
                forward.append(char)
                continue
            if char in '\r\n':
                command = self.buffer.strip()
                self.buffer = ''
                rule = self.match(command) if command else None
                if rule and rule.action == ACTION_BLOCK:
                    # 清掉远端已输入的命令，回车不下发 → 命令不执行
                    forward.append('\x15')
                    events.append({'action': ACTION_BLOCK, 'command': command, 'rule': rule})
                else:
                    forward.append(char)
                    if rule:
                        events.append({'action': rule.action, 'command': command, 'rule': rule})
                continue
            if char in ('\x7f', '\b'):
                self.buffer = self.buffer[:-1]
                forward.append(char)
                continue
            if char in ('\x03', '\x15'):
                self.buffer = ''
                forward.append(char)
                continue
            if char.isprintable():
                if len(self.buffer) < MAX_COMMAND_LENGTH:
                    self.buffer += char
                forward.append(char)
                continue
            forward.append(char)
        return ''.join(forward), events


def load_rules():
    """加载启用规则并编译正则；非法正则跳过并告警，不影响其余规则。"""
    from .models import WebShellCommandRule

    compiled = []
    for rule in WebShellCommandRule.objects.filter(enabled=True).order_by('priority', 'id'):
        try:
            compiled.append((rule, re.compile(rule.pattern)))
        except re.error as exc:
            logger.warning('WebShell 规则 %s 正则非法，已跳过: %s', rule.name, exc)
    return compiled


def blocked_message(rule, command):
    return f'\r\n\x1b[31m[安全拦截] 命令「{command}」命中高危规则「{rule.name}」，已被阻止执行。\x1b[0m\r\n'


def warn_message(rule, command):
    return f'\r\n\x1b[33m[安全告警] 命令「{command}」命中规则「{rule.name}」，已放行并记录审计。\x1b[0m\r\n'


_EVENT_SEVERITY = {'critical': 'danger', 'warning': 'warning', 'info': 'info'}


def handle_guard_events(events, *, user, resource_type, resource_name, send_text, resource_id=''):
    """统一处理命中事件：写审计 + 向终端回显拦截/告警提示。"""
    from eventwall.models import EventRecord
    from eventwall.services import record_event

    for event in events:
        rule = event['rule']
        command = event['command']
        action = event['action']
        if action == ACTION_BLOCK:
            send_text(blocked_message(rule, command))
            record_event(
                module='ops', category='security', action='webshell_block',
                title=f'拦截高危命令：{rule.name}',
                summary=f'命令「{command}」命中规则「{rule.name}」，已阻止执行',
                result=EventRecord.RESULT_FAILED, severity=_EVENT_SEVERITY.get(rule.severity, 'warning'),
                actor_username=user.username, resource_type=resource_type,
                resource_id=resource_id, resource_name=resource_name,
                metadata={'command': command, 'rule_id': rule.pk, 'pattern': rule.pattern},
            )
        elif action == ACTION_WARN:
            send_text(warn_message(rule, command))
            record_event(
                module='ops', category='security', action='webshell_warn',
                title=f'高危命令告警：{rule.name}',
                summary=f'命令「{command}」命中规则「{rule.name}」，已放行并审计',
                result=EventRecord.RESULT_SUCCESS, severity=_EVENT_SEVERITY.get(rule.severity, 'warning'),
                actor_username=user.username, resource_type=resource_type,
                resource_id=resource_id, resource_name=resource_name,
                metadata={'command': command, 'rule_id': rule.pk},
            )
        else:
            record_event(
                module='ops', category='security', action='webshell_audit',
                title=f'命令审计：{rule.name}',
                summary=f'命令「{command}」命中审计规则「{rule.name}」',
                result=EventRecord.RESULT_SUCCESS, severity='info',
                actor_username=user.username, resource_type=resource_type,
                resource_id=resource_id, resource_name=resource_name,
                metadata={'command': command, 'rule_id': rule.pk},
            )