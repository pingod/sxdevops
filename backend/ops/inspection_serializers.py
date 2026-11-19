from rest_framework import serializers

from .inspection_items import MIDDLEWARE_CI_TYPE_CODES
from .inspection_schedules import compute_plan_next_run
from .host_task_schedules import CronExpressionError, validate_cron_expression
from .models import InspectionIssue, InspectionItem, InspectionPlan, InspectionResult, InspectionRun


class InspectionItemSerializer(serializers.ModelSerializer):
    category_display = serializers.CharField(source='get_category_display', read_only=True)

    class Meta:
        model = InspectionItem
        fields = [
            'id', 'code', 'name', 'category', 'category_display', 'description', 'weight',
            'threshold_config', 'remediation', 'is_builtin', 'is_enabled', 'sort_order',
        ]
        read_only_fields = ['code', 'name', 'category', 'description', 'is_builtin', 'sort_order']

    def validate_weight(self, value):
        if value < 1 or value > 100:
            raise serializers.ValidationError('扣分权重需位于 1-100。')
        return value

    def validate_threshold_config(self, value):
        if value in (None, ''):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError('阈值配置必须是对象。')
        comparison = str(value.get('comparison') or '')
        if comparison not in ('gte', 'lte', 'eq', 'flag'):
            raise serializers.ValidationError('comparison 仅支持 gte / lte / eq / flag。')
        for key in ('warning', 'critical'):
            if key in value and value[key] not in (None, ''):
                try:
                    float(value[key])
                except (TypeError, ValueError):
                    raise serializers.ValidationError(f'{key} 必须是数值。')
        if comparison == 'eq' and not str(value.get('expect') or '').strip():
            raise serializers.ValidationError('comparison=eq 时必须提供 expect。')
        return value


class InspectionPlanSerializer(serializers.ModelSerializer):
    schedule_type_display = serializers.CharField(source='get_schedule_type_display', read_only=True)
    next_run_at = serializers.DateTimeField(read_only=True)

    class Meta:
        model = InspectionPlan
        fields = [
            'id', 'name', 'description', 'enabled', 'scope', 'item_codes', 'schedule_type',
            'schedule_type_display', 'cron_expression', 'interval_seconds', 'run_at', 'timezone',
            'next_run_at', 'last_run_at', 'last_status', 'consecutive_failures', 'total_run_count',
            'last_error', 'ai_analysis_enabled', 'created_by', 'updated_by', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'next_run_at', 'last_run_at', 'last_status', 'consecutive_failures',
            'total_run_count', 'last_error', 'created_by', 'updated_by', 'created_at', 'updated_at',
        ]

    def validate_name(self, value):
        name = str(value or '').strip()
        if not name:
            raise serializers.ValidationError('请填写巡检计划名称。')
        return name[:128]

    def validate_item_codes(self, value):
        codes = [str(item).strip() for item in (value or []) if str(item).strip()]
        if not codes:
            return []
        enabled = set(InspectionItem.objects.filter(is_enabled=True, code__in=codes).values_list('code', flat=True))
        unknown = [code for code in codes if code not in enabled]
        if unknown:
            raise serializers.ValidationError(f'巡检项不存在或已停用：{", ".join(unknown[:5])}')
        return list(dict.fromkeys(codes))

    def validate_scope(self, value):
        if value in (None, ''):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError('巡检范围必须是对象。')
        middleware = value.get('middleware') or {}
        type_codes = [str(item).strip().upper() for item in (middleware.get('ci_type_codes') or []) if str(item).strip()]
        invalid = [code for code in type_codes if code not in MIDDLEWARE_CI_TYPE_CODES]
        if invalid:
            raise serializers.ValidationError({'middleware': f'不支持的中间件类型：{", ".join(invalid)}'})
        return value

    def validate(self, attrs):
        schedule_type = attrs.get('schedule_type') or getattr(self.instance, 'schedule_type', InspectionPlan.SCHEDULE_TYPE_MANUAL)
        if schedule_type != InspectionPlan.SCHEDULE_TYPE_MANUAL:
            cron_expression = attrs.get('cron_expression')
            if cron_expression is None and self.instance is not None:
                cron_expression = self.instance.cron_expression
            interval_seconds = attrs.get('interval_seconds')
            if interval_seconds is None and self.instance is not None:
                interval_seconds = self.instance.interval_seconds
            if schedule_type == InspectionPlan.SCHEDULE_TYPE_CRON:
                if not str(cron_expression or '').strip():
                    raise serializers.ValidationError({'cron_expression': 'Cron 调度需要填写表达式。'})
                try:
                    validate_cron_expression(cron_expression)
                except CronExpressionError as exc:
                    raise serializers.ValidationError({'cron_expression': str(exc)})
            elif schedule_type == InspectionPlan.SCHEDULE_TYPE_INTERVAL:
                if not interval_seconds:
                    raise serializers.ValidationError({'interval_seconds': '间隔调度需要填写间隔秒数。'})
                if int(interval_seconds) < 60:
                    raise serializers.ValidationError({'interval_seconds': '间隔不能小于 60 秒。'})
            elif schedule_type == InspectionPlan.SCHEDULE_TYPE_ONCE:
                run_at = attrs.get('run_at') or getattr(self.instance, 'run_at', None)
                if not run_at:
                    raise serializers.ValidationError({'run_at': '单次调度需要填写执行时间。'})
        return attrs


class InspectionResultSerializer(serializers.ModelSerializer):
    severity_display = serializers.CharField(source='get_severity_display', read_only=True)

    class Meta:
        model = InspectionResult
        fields = [
            'id', 'target_type', 'target_key', 'target_id', 'target_name', 'target_ip',
            'item_code', 'item_name', 'category', 'severity', 'severity_display',
            'value', 'threshold', 'message', 'evidence', 'duration_ms',
        ]
        read_only_fields = fields


class InspectionRunSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    trigger_source_display = serializers.CharField(source='get_trigger_source_display', read_only=True)
    ai_status_display = serializers.CharField(source='get_ai_status_display', read_only=True)

    class Meta:
        model = InspectionRun
        fields = [
            'id', 'plan', 'plan_name', 'status', 'status_display', 'trigger_source', 'trigger_source_display',
            'started_at', 'finished_at', 'duration_ms', 'target_count', 'item_count',
            'ok_count', 'warning_count', 'critical_count', 'unknown_count', 'score', 'summary',
            'ai_status', 'ai_status_display', 'ai_summary', 'ai_error',
            'scope_snapshot', 'created_by', 'created_at',
        ]
        read_only_fields = fields


class InspectionRunDetailSerializer(InspectionRunSerializer):
    results = InspectionResultSerializer(many=True, read_only=True)
    ai_payload = serializers.JSONField(read_only=True)
    item_codes = serializers.JSONField(read_only=True)

    class Meta(InspectionRunSerializer.Meta):
        fields = [*InspectionRunSerializer.Meta.fields, 'results', 'ai_payload', 'item_codes']
        read_only_fields = fields


class InspectionIssueSerializer(serializers.ModelSerializer):
    severity_display = serializers.CharField(source='get_severity_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    days_open = serializers.SerializerMethodField()

    class Meta:
        model = InspectionIssue
        fields = [
            'id', 'item_code', 'item_name', 'category', 'target_type', 'target_key', 'target_name',
            'target_ip', 'severity', 'severity_display', 'status', 'status_display', 'title', 'detail',
            'ai_advice', 'first_seen_at', 'last_seen_at', 'resolved_at', 'occurrences', 'days_open',
            'first_run', 'last_run', 'owner', 'updated_by', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_days_open(self, obj):
        from django.utils import timezone

        end = obj.resolved_at or timezone.now()
        return max((end - obj.first_seen_at).days, 0)


def plan_next_run_value(plan):
    return compute_plan_next_run(plan)
