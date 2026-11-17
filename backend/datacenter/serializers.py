"""项目 JSON 的入库校验与清洗。

校验只守住查看器真正依赖的结构：`objects` 数组、每个对象有 `id`/`type`、
至少一台机柜。类型白名单不做——查看器对未知类型是跳过而不是报错，提前拒绝
只会让新版本导出的项目无法入库。
"""
import hashlib
import json
import os

from rest_framework import serializers

from .models import TwinProject

#: 单项目上限。样例项目 109KB，真实机房约 1–3MB；16MB 足够且不会撑爆容器内存。
MAX_PROJECT_BYTES = 16 * 1024 * 1024


def parse_project(raw_bytes, filename=''):
    """把上传的 JSON 解析成可入库字段；结构不合法直接抛 ValidationError。"""
    if len(raw_bytes) > MAX_PROJECT_BYTES:
        raise serializers.ValidationError(
            f'项目文件超过 {MAX_PROJECT_BYTES // (1024 * 1024)}MB 上限。'
        )
    try:
        text = raw_bytes.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise serializers.ValidationError('项目文件必须是 UTF-8 编码的 JSON。') from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise serializers.ValidationError(f'JSON 解析失败：第 {exc.lineno} 行第 {exc.colno} 列 {exc.msg}。') from exc
    if not isinstance(data, dict):
        raise serializers.ValidationError('项目文件根节点必须是对象。')
    objects = data.get('objects')
    if not isinstance(objects, list) or not objects:
        raise serializers.ValidationError('项目文件缺少非空的 objects 数组。')

    seen_ids = set()
    has_cabinet = False
    for index, obj in enumerate(objects):
        if not isinstance(obj, dict):
            raise serializers.ValidationError(f'objects[{index}] 不是对象。')
        obj_id = obj.get('id')
        obj_type = obj.get('type')
        if not isinstance(obj_id, str) or not obj_id.strip():
            raise serializers.ValidationError(f'objects[{index}] 缺少 id。')
        if not isinstance(obj_type, str) or not obj_type.strip():
            raise serializers.ValidationError(f'objects[{index}]（{obj_id}）缺少 type。')
        if obj_id in seen_ids:
            raise serializers.ValidationError(f'objects[{index}] 的 id 重复：{obj_id}。')
        seen_ids.add(obj_id)
        if obj_type == 'cabinet':
            has_cabinet = True
    if not has_cabinet:
        raise serializers.ValidationError('项目文件里没有任何 cabinet 对象，无法确认是机房项目。')

    project_name = data.get('name') if isinstance(data.get('name'), str) else ''
    project_name = project_name.strip()[:120]
    canonical = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    fallback_name = os.path.splitext(os.path.basename(filename or ''))[0].strip()
    return {
        'name_hint': project_name or fallback_name[:120],
        'project_name': project_name,
        'content': canonical,
        'object_count': len(objects),
        'size_bytes': len(raw_bytes),
        'checksum': hashlib.sha256(canonical.encode('utf-8')).hexdigest(),
    }


class TwinProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = TwinProject
        fields = [
            'id', 'name', 'description', 'project_name', 'object_count',
            'size_bytes', 'checksum', 'uploaded_by', 'created_at', 'updated_at',
        ]
        read_only_fields = fields


class TwinProjectUploadSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    file = serializers.FileField()

    def validate_file(self, value):
        parsed = parse_project(value.read(), getattr(value, 'name', ''))
        self._parsed = parsed
        name = (self.initial_data.get('name') or '').strip() or parsed['name_hint']
        if not name:
            raise serializers.ValidationError('请填写项目名称，或让项目文件带上 name 字段。')
        if TwinProject.objects.filter(name__iexact=name).exists():
            raise serializers.ValidationError(f'项目名称「{name}」已存在。')
        duplicate = TwinProject.objects.filter(checksum=parsed['checksum']).first()
        if duplicate:
            raise serializers.ValidationError(f'项目内容与已有项目「{duplicate.name}」完全相同。')
        self._resolved_name = name[:120]
        return value

    def create(self, validated_data):
        parsed = self._parsed
        return TwinProject.objects.create(
            name=self._resolved_name,
            description=(validated_data.get('description') or '').strip()[:255],
            project_name=parsed['project_name'],
            content=parsed['content'],
            object_count=parsed['object_count'],
            size_bytes=parsed['size_bytes'],
            checksum=parsed['checksum'],
            uploaded_by=self.context.get('uploader', ''),
        )


class TwinProjectUpdateSerializer(serializers.Serializer):
    """设计器保存：项目 JSON 是结构化对象，不是上传文件。"""

    name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    project = serializers.JSONField()

    def validate(self, attrs):
        instance = self.instance
        parsed = parse_project(json.dumps(attrs['project'], ensure_ascii=False).encode('utf-8'))
        name = (attrs.get('name') or '').strip() or instance.name
        if TwinProject.objects.exclude(pk=instance.pk).filter(name__iexact=name).exists():
            raise serializers.ValidationError({'name': f'项目名称「{name}」已存在。'})
        duplicate = TwinProject.objects.exclude(pk=instance.pk).filter(checksum=parsed['checksum']).first()
        if duplicate:
            raise serializers.ValidationError({'project': f'项目内容与已有项目「{duplicate.name}」完全相同。'})
        attrs['name'] = name[:120]
        attrs['parsed'] = parsed
        return attrs

    def update(self, instance, validated_data):
        parsed = validated_data['parsed']
        instance.name = validated_data['name']
        if 'description' in validated_data:
            instance.description = (validated_data['description'] or '').strip()[:255]
        instance.project_name = parsed['project_name'] or instance.project_name
        instance.content = parsed['content']
        instance.object_count = parsed['object_count']
        instance.size_bytes = parsed['size_bytes']
        instance.checksum = parsed['checksum']
        instance.save()
        return instance
