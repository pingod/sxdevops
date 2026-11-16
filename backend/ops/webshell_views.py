import re

from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from eventwall.services import record_event
from rbac.permissions import RBACPermissionMixin

from .models import WebShellCommandRule
from .webshell_guard import load_rules


class WebShellCommandRuleSerializer(serializers.ModelSerializer):
    action_display = serializers.CharField(source='get_action_display', read_only=True)
    severity_display = serializers.CharField(source='get_severity_display', read_only=True)

    class Meta:
        model = WebShellCommandRule
        fields = [
            'id', 'name', 'pattern', 'action', 'action_display', 'severity', 'severity_display',
            'priority', 'enabled', 'description', 'is_builtin', 'created_at', 'updated_at',
        ]
        read_only_fields = ['is_builtin']

    def validate_pattern(self, value):
        try:
            re.compile(value)
        except re.error as exc:
            raise serializers.ValidationError(f'正则表达式非法：{exc}')
        return value


class WebShellCommandRuleViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = WebShellCommandRule.objects.all()
    serializer_class = WebShellCommandRuleSerializer
    rbac_permissions = {
        'list': ['ops.webshell.rule.view'],
        'retrieve': ['ops.webshell.rule.view'],
        'create': ['ops.webshell.rule.manage'],
        'update': ['ops.webshell.rule.manage'],
        'partial_update': ['ops.webshell.rule.manage'],
        'destroy': ['ops.webshell.rule.manage'],
        'test': ['ops.webshell.rule.view'],
        'audit': ['ops.webshell.rule.view'],
    }

    def _audit(self, action_name, title, instance, summary=''):
        record_event(
            request=self.request, module='ops', category='security', action=action_name, title=title,
            summary=summary or title, resource_type='webshell_rule',
            resource_id=instance.pk if instance else '', resource_name=instance.name if instance else '',
        )

    def perform_create(self, serializer):
        rule = serializer.save()
        self._audit('webshell_rule_create', f'新建 WebShell 规则：{rule.name}', rule)

    def perform_update(self, serializer):
        rule = serializer.save()
        self._audit('webshell_rule_update', f'更新 WebShell 规则：{rule.name}', rule)

    def perform_destroy(self, instance):
        if instance.is_builtin:
            raise serializers.ValidationError({'detail': '内置规则不可删除，可停用或调整动作。'})
        name = instance.name
        instance.delete()
        record_event(
            request=self.request, module='ops', category='security', action='webshell_rule_delete',
            title=f'删除 WebShell 规则：{name}', resource_type='webshell_rule', resource_name=name,
        )

    def handle_exception(self, exc):
        if isinstance(exc, serializers.ValidationError) and 'detail' in exc.detail:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
        return super().handle_exception(exc)

    @action(detail=False, methods=['post'])
    def test(self, request):
        command = str(request.data.get('command', '')).strip()
        if not command:
            return Response({'detail': '请提供要测试的命令。'}, status=status.HTTP_400_BAD_REQUEST)
        for rule, pattern in load_rules():
            if pattern.search(command):
                return Response({
                    'matched': True,
                    'command': command,
                    'rule': WebShellCommandRuleSerializer(rule).data,
                })
        return Response({'matched': False, 'command': command, 'rule': None})

    @action(detail=False, methods=['get'])
    def audit(self, request):
        from eventwall.models import EventRecord

        queryset = EventRecord.objects.filter(module='ops', action__startswith='webshell').order_by('-occurred_at')
        action_filter = request.query_params.get('action', '').strip()
        if action_filter:
            queryset = queryset.filter(action=action_filter)
        page = self.paginate_queryset(queryset)
        rows = page if page is not None else queryset[:100]
        data = [
            {
                'id': event.pk, 'occurred_at': event.occurred_at.isoformat(), 'action': event.action,
                'title': event.title, 'summary': event.summary, 'severity': event.severity,
                'result': event.result, 'actor_username': event.actor_username,
                'resource_type': event.resource_type, 'resource_name': event.resource_name,
                'command': (event.metadata or {}).get('command', ''),
            }
            for event in rows
        ]
        if page is not None:
            return self.get_paginated_response(data)
        return Response(data)