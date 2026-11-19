"""巡检中心 API：巡检项、计划、执行记录、隐患台账与总览。"""

from datetime import timedelta

from django.db.models import Avg, Count
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response

from eventwall.mixins import EventWallModelViewSetMixin
from eventwall.services import record_event
from rbac.permissions import RBACPermissionMixin, build_rbac_permission

from .inspection_runner import (
    build_run_report_markdown,
    mark_stale_inspection_runs,
    start_inspection_run,
)
from .inspection_schedules import (
    create_run_from_plan,
    preview_plan_next_runs,
    refresh_plan_schedule,
)
from .inspection_serializers import (
    InspectionIssueSerializer,
    InspectionItemSerializer,
    InspectionPlanSerializer,
    InspectionRunDetailSerializer,
    InspectionRunSerializer,
)
from .models import InspectionIssue, InspectionItem, InspectionPlan, InspectionResult, InspectionRun


class InspectionItemViewSet(RBACPermissionMixin, viewsets.ReadOnlyModelViewSet):
    queryset = InspectionItem.objects.all()
    serializer_class = InspectionItemSerializer
    http_method_names = ['get', 'patch', 'head', 'options']
    search_fields = ['code', 'name', 'description']
    filterset_fields = ['category', 'is_enabled', 'is_builtin']
    rbac_permissions = {
        'list': ['ops.inspection.view'],
        'retrieve': ['ops.inspection.view'],
        'partial_update': ['ops.inspection.manage'],
    }

    def get_queryset(self):
        return InspectionItem.objects.order_by('category', 'sort_order', 'id')

    def partial_update(self, request, *args, **kwargs):
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(self.get_serializer(instance).data)


class InspectionPlanViewSet(EventWallModelViewSetMixin, RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = InspectionPlan.objects.all()
    serializer_class = InspectionPlanSerializer
    search_fields = ['name', 'description', 'created_by']
    filterset_fields = ['enabled', 'schedule_type', 'last_status']
    event_module = 'ops'
    event_resource_type = 'inspection_plan'
    event_resource_label = '巡检计划'
    event_resource_name_fields = ('name',)
    rbac_permissions = {
        'list': ['ops.inspection.view'],
        'retrieve': ['ops.inspection.view'],
        'create': ['ops.inspection.manage'],
        'update': ['ops.inspection.manage'],
        'partial_update': ['ops.inspection.manage'],
        'destroy': ['ops.inspection.manage'],
        'toggle_enabled': ['ops.inspection.manage'],
        'preview_next_runs': ['ops.inspection.manage'],
        'run_now': ['ops.inspection.execute'],
    }

    def get_queryset(self):
        return InspectionPlan.objects.order_by('-enabled', 'next_run_at', '-id')

    def _persist_plan(self, serializer, created=False):
        actor = getattr(self.request.user, 'username', '') or ''
        plan = serializer.save(
            updated_by=actor,
            **({'created_by': actor} if created else {}),
        )
        plan.next_run_at = refresh_plan_schedule(plan)
        plan.save(update_fields=['next_run_at', 'updated_at'])
        return plan

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        plan = self._persist_plan(serializer, created=True)
        return Response(self.get_serializer(plan).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        plan = self._persist_plan(serializer)
        return Response(self.get_serializer(plan).data)

    def partial_update(self, request, *args, **kwargs):
        kwargs['partial'] = True
        return self.update(request, *args, **kwargs)

    @action(detail=True, methods=['post'])
    def toggle_enabled(self, request, pk=None):
        plan = self.get_object()
        plan.enabled = not plan.enabled
        plan.next_run_at = refresh_plan_schedule(plan) if plan.enabled else None
        plan.updated_by = getattr(request.user, 'username', '') or ''
        plan.save(update_fields=['enabled', 'next_run_at', 'updated_by', 'updated_at'])
        return Response(self.get_serializer(plan).data)

    @action(detail=True, methods=['post'])
    def run_now(self, request, pk=None):
        plan = self.get_object()
        run, error = create_run_from_plan(
            plan,
            actor=getattr(request.user, 'username', '') or '',
            trigger_source=InspectionRun.TRIGGER_MANUAL,
        )
        if run is None:
            return Response({'detail': error}, status=status.HTTP_400_BAD_REQUEST)
        run.refresh_from_db()
        return Response({'run_id': run.id, 'status': run.status})

    @action(detail=True, methods=['get'])
    def preview_next_runs(self, request, pk=None):
        plan = self.get_object()
        try:
            count = int(request.query_params.get('count') or 5)
        except (TypeError, ValueError):
            count = 5
        count = max(1, min(count, 10))
        runs = preview_plan_next_runs(plan, count=count)
        return Response({'next_runs': [timezone.localtime(item).isoformat() if item else None for item in runs]})


class InspectionRunViewSet(RBACPermissionMixin, viewsets.ReadOnlyModelViewSet):
    queryset = InspectionRun.objects.all()
    serializer_class = InspectionRunSerializer
    http_method_names = ['get', 'post', 'head', 'options']
    search_fields = ['plan_name', 'summary', 'created_by']
    filterset_fields = ['status', 'trigger_source', 'plan', 'ai_status']
    ordering_fields = ['created_at', 'score']
    rbac_permissions = {
        'list': ['ops.inspection.view'],
        'retrieve': ['ops.inspection.view'],
        'report': ['ops.inspection.view'],
        'rerun': ['ops.inspection.execute'],
        'analyze': ['ops.inspection.analyze'],
    }

    def get_queryset(self):
        return InspectionRun.objects.select_related('plan').order_by('-created_at', '-id')

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return InspectionRunDetailSerializer
        return InspectionRunSerializer

    def list(self, request, *args, **kwargs):
        mark_stale_inspection_runs()
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=['post'])
    def rerun(self, request, pk=None):
        source = self.get_object()
        run = InspectionRun.objects.create(
            plan=source.plan,
            plan_name=source.plan_name or (source.plan.name if source.plan else ''),
            status=InspectionRun.STATUS_PENDING,
            trigger_source=InspectionRun.TRIGGER_MANUAL,
            item_codes=list(source.item_codes or []),
            item_count=len(source.item_codes or []),
            scope_snapshot=source.scope_snapshot or {},
            created_by=getattr(request.user, 'username', '') or '',
        )
        start_inspection_run(run.id)
        run.refresh_from_db()
        return Response({'run_id': run.id, 'status': run.status})

    @action(detail=True, methods=['post'])
    def analyze(self, request, pk=None):
        from aiops.inspection import AIOpsInspectionNotConfigured, analyze_run

        run = self.get_object()
        force = bool(request.data.get('force'))
        try:
            payload = analyze_run(run, user=request.user, force=force)
        except AIOpsInspectionNotConfigured as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        run.refresh_from_db()
        return Response({
            'ai_status': run.ai_status,
            'ai_summary': run.ai_summary,
            'ai_payload': payload if isinstance(payload, dict) else (run.ai_payload or {}),
            'ai_error': run.ai_error,
        })

    @action(detail=True, methods=['get'])
    def report(self, request, pk=None):
        run = self.get_object()
        return Response({'markdown': build_run_report_markdown(run), 'filename': f'inspection-{run.id}.md'})


class InspectionIssueViewSet(RBACPermissionMixin, viewsets.ReadOnlyModelViewSet):
    queryset = InspectionIssue.objects.all()
    serializer_class = InspectionIssueSerializer
    http_method_names = ['get', 'post', 'head', 'options']
    search_fields = ['title', 'target_name', 'item_name']
    filterset_fields = ['status', 'severity', 'category', 'target_type', 'item_code']
    rbac_permissions = {
        'list': ['ops.inspection.view'],
        'retrieve': ['ops.inspection.view'],
        'acknowledge': ['ops.inspection.manage'],
        'ignore': ['ops.inspection.manage'],
        'resolve': ['ops.inspection.manage'],
    }

    def get_queryset(self):
        return InspectionIssue.objects.order_by('-last_seen_at', '-id')

    def list(self, request, *args, **kwargs):
        mark_stale_inspection_runs()
        return super().list(request, *args, **kwargs)

    def _set_status(self, request, pk, new_status, action_name):
        issue = self.get_object()
        issue.status = new_status
        issue.updated_by = getattr(request.user, 'username', '') or ''
        if new_status == InspectionIssue.STATUS_RESOLVED:
            issue.resolved_at = timezone.now()
        elif new_status in (InspectionIssue.STATUS_OPEN, InspectionIssue.STATUS_ACKNOWLEDGED):
            issue.resolved_at = None
        issue.save(update_fields=['status', 'updated_by', 'resolved_at', 'updated_at'])
        record_event(
            module='ops',
            category='execution',
            action=f'inspection_issue_{action_name}',
            title=f'巡检隐患{issue.get_status_display()}：{issue.title}',
            summary=f'{issue.target_name} / {issue.item_name}',
            actor_username=getattr(request.user, 'username', '') or '',
            resource_type='inspection_issue',
            resource_id=issue.id,
            resource_name=issue.title,
            metadata={'status': issue.status, 'severity': issue.severity},
        )
        return Response(self.get_serializer(issue).data)

    @action(detail=True, methods=['post'])
    def acknowledge(self, request, pk=None):
        return self._set_status(request, pk, InspectionIssue.STATUS_ACKNOWLEDGED, 'acknowledge')

    @action(detail=True, methods=['post'])
    def ignore(self, request, pk=None):
        return self._set_status(request, pk, InspectionIssue.STATUS_IGNORED, 'ignore')

    @action(detail=True, methods=['post'])
    def resolve(self, request, pk=None):
        return self._set_status(request, pk, InspectionIssue.STATUS_RESOLVED, 'resolve')


@api_view(['GET'])
@permission_classes([build_rbac_permission('ops.inspection.view')])
def inspection_overview(request):
    mark_stale_inspection_runs()
    now = timezone.localtime()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    active_issues = InspectionIssue.objects.filter(status__in=InspectionIssue.ACTIVE_STATUSES)
    open_count = active_issues.count()
    critical_count = active_issues.filter(severity=InspectionIssue.SEVERITY_CRITICAL).count()

    week_ago = timezone.now() - timedelta(days=7)
    avg_score = (
        InspectionRun.objects.filter(created_at__gte=week_ago)
        .exclude(status=InspectionRun.STATUS_FAILED)
        .aggregate(value=Avg('score'))['value']
    )
    trend = []
    for offset in range(6, -1, -1):
        day = (now - timedelta(days=offset)).date()
        day_start = timezone.make_aware(
            timezone.datetime.combine(day, timezone.datetime.min.time()), timezone.get_current_timezone(),
        )
        day_end = day_start + timedelta(days=1)
        value = (
            InspectionRun.objects.filter(created_at__gte=day_start, created_at__lt=day_end)
            .exclude(status=InspectionRun.STATUS_FAILED)
            .aggregate(value=Avg('score'))['value']
        )
        trend.append({'date': day.strftime('%Y-%m-%d'), 'score': round(value, 1) if value is not None else None})

    latest_run = (
        InspectionRun.objects.exclude(status__in=[InspectionRun.STATUS_PENDING, InspectionRun.STATUS_RUNNING, InspectionRun.STATUS_FAILED])
        .order_by('-created_at', '-id').first()
    )
    distribution = {'ok': 0, 'warning': 0, 'critical': 0, 'unknown': 0}
    if latest_run:
        rows = InspectionResult.objects.filter(run=latest_run).values('severity').annotate(total=Count('id'))
        for row in rows:
            if row['severity'] in distribution:
                distribution[row['severity']] = row['total']

    severity_order = {InspectionIssue.SEVERITY_CRITICAL: 0, InspectionIssue.SEVERITY_WARNING: 1}
    top_issues = sorted(
        active_issues.order_by('-occurrences', '-last_seen_at')[:20],
        key=lambda item: (severity_order.get(item.severity, 9), -item.occurrences),
    )[:5]
    return Response({
        'today_runs': InspectionRun.objects.filter(created_at__gte=today_start).count(),
        'open_issues': open_count,
        'critical_issues': critical_count,
        'avg_score_7d': round(avg_score, 1) if avg_score is not None else 0,
        'score_trend': trend,
        'severity_distribution': distribution,
        'top_issues': [
            {
                'id': issue.id,
                'title': issue.title,
                'severity': issue.severity,
                'occurrences': issue.occurrences,
                'days_open': max((timezone.now() - issue.first_seen_at).days, 0),
            }
            for issue in top_issues
        ],
    })


@api_view(['POST'])
@permission_classes([build_rbac_permission('ops.inspection.analyze')])
def inspection_recommend_items(request):
    from aiops.inspection import recommend_items

    scope = request.data.get('scope') if isinstance(request.data.get('scope'), dict) else {}
    goal = str(request.data.get('goal') or '')
    return Response(recommend_items(scope, goal=goal, user=request.user))
