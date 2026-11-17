"""项目 JSON 的入库校验与清洗。

校验守住查看器与设计器共同依赖的结构：类型白名单、数值边界、开洞与墙/柱的
引用完整性、项目规模，以及机柜到网络设备的监控绑定。类型白名单此前有意不做，
代价是脏数据能进库并让三维场景静默跳过对象；现在设计器只能产出白名单内的类型，
进库即拒比事后排查更省钱。
"""
import hashlib
import json
import math
import os

from rest_framework import serializers

from .models import TwinProject

#: 单项目上限。样例项目 109KB，真实机房约 1–3MB；16MB 足够且不会撑爆容器内存。
MAX_PROJECT_BYTES = 16 * 1024 * 1024

#: 设计器构件白名单：与 tools/dc-viewer/src/design/store.js 的 TOOL_DEFS 对齐。
OBJECT_TYPES = {
    'wall', 'column', 'beam', 'cabinet', 'pdu', 'ac', 'ups', 'battery',
    'extinguisher', 'vent', 'tray', 'aisle', 'door', 'window', 'grille',
}
OPENING_TYPES = {'door', 'window', 'grille'}

MAX_COORD = 1_000_000
MAX_OBJECTS = 5000
MAX_CABINETS = 3000
MAX_OPENING_WIDTH = 20000
MAX_MONITOR_DEVICES = 20


def _number(where, container, key, label, lo=None, hi=None):
    """读取可选数值字段：缺失返回 None；非数字、NaN、越界一律拒绝。"""
    value = container.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise serializers.ValidationError(f'{where} 的 {label} 必须是数字。')
    if isinstance(value, float) and not math.isfinite(value):
        raise serializers.ValidationError(f'{where} 的 {label} 必须是有限数字。')
    if lo is not None and value < lo:
        raise serializers.ValidationError(f'{where} 的 {label} 不能小于 {lo:g}。')
    if hi is not None and value > hi:
        raise serializers.ValidationError(f'{where} 的 {label} 不能大于 {hi:g}。')
    return value


def _props(where, obj):
    props = obj.get('props')
    if props is None:
        return {}
    if not isinstance(props, dict):
        raise serializers.ValidationError(f'{where} 的 props 必须是对象。')
    return props


def _wall_length(wall):
    """墙长（mm）；坐标缺失按 0 处理，与查看器的降级行为一致。"""
    try:
        return math.hypot(float(wall.get('x2') or 0) - float(wall.get('x1') or 0),
                          float(wall.get('y2') or 0) - float(wall.get('y1') or 0))
    except (TypeError, ValueError):
        return 0.0


def _validate_bindings(objects):
    """机柜→网络设备绑定：只允许真实存在的 NetworkDevice.id，最多 20 个。"""
    wanted = set()
    for obj in objects:
        monitor = (obj.get('props') or {}).get('monitor')
        if not monitor:
            continue
        ids = monitor.get('deviceIds') if isinstance(monitor, dict) else None
        if ids is None:
            continue
        if not isinstance(ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
            raise serializers.ValidationError('监控绑定的 deviceIds 必须是整数数组。')
        if len(ids) > MAX_MONITOR_DEVICES:
            raise serializers.ValidationError(f'单个对象最多绑定 {MAX_MONITOR_DEVICES} 台网络设备。')
        wanted.update(ids)
    if not wanted:
        return
    from network.models import NetworkDevice  # 局部导入：避免 app 载入期循环依赖

    existing = set(NetworkDevice.objects.filter(id__in=wanted).values_list('id', flat=True))
    missing = sorted(wanted - existing)
    if missing:
        raise serializers.ValidationError(
            f'监控绑定包含不存在的网络设备 ID：{", ".join(str(i) for i in missing)}。'
        )


def _validate_objects(objects):
    if len(objects) > MAX_OBJECTS:
        raise serializers.ValidationError(f'项目对象数 {len(objects)} 超过 {MAX_OBJECTS} 上限。')

    walls = {}
    columns = set()
    cabinet_count = 0

    for index, obj in enumerate(objects):
        where = f'objects[{index}]'
        if not isinstance(obj, dict):
            raise serializers.ValidationError(f'{where} 不是对象。')
        obj_id = obj.get('id')
        obj_type = obj.get('type')
        if not isinstance(obj_id, str) or not obj_id.strip():
            raise serializers.ValidationError(f'{where} 缺少 id。')
        if not isinstance(obj_type, str) or not obj_type.strip():
            raise serializers.ValidationError(f'{where}（{obj_id}）缺少 type。')
        if obj_type not in OBJECT_TYPES:
            raise serializers.ValidationError(f'{where} 的类型 {obj_type} 不受支持。')

        props = _props(where, obj)
        for key in ('x', 'y', 'x1', 'y1', 'x2', 'y2'):
            _number(where, obj, key, key, -MAX_COORD, MAX_COORD)
        if 'rotation' in obj:
            _number(where, obj, 'rotation', 'rotation')

        _number(where, props, 'w', '宽', 1, 100000)
        _number(where, props, 'd', '深', 1, 100000)
        _number(where, props, 'h', '高', 1, 100000)
        _number(where, props, 'thickness', '厚度', 1, 2000)
        _number(where, props, 'height', 'height', 1, 20000)

        if obj_type in OPENING_TYPES:
            _number(where, props, 'width', '开洞宽度', 100, MAX_OPENING_WIDTH)
            _number(where, props, 'sill', '窗台高', 0, 5000)
            _number(where, obj, 't', '沿墙位置 t', 0, 1)
            if not isinstance(obj.get('wallId'), str) or not obj['wallId'].strip():
                raise serializers.ValidationError(f'{where} 的开洞缺少所属墙 wallId。')

        if obj_type == 'wall':
            walls[obj_id] = obj
        elif obj_type == 'column':
            columns.add(obj_id)
        elif obj_type == 'cabinet':
            cabinet_count += 1

    if cabinet_count > MAX_CABINETS:
        raise serializers.ValidationError(f'机柜数 {cabinet_count} 超过 {MAX_CABINETS} 上限。')

    meta = None
    for index, obj in enumerate(objects):
        where = f'objects[{index}]'
        obj_type = obj['type']
        if obj_type in OPENING_TYPES:
            wall = walls.get(obj['wallId'])
            if wall is None:
                raise serializers.ValidationError(
                    f'{where} 的所属墙 {obj["wallId"]} 不存在（wallId 必须指向本项目的 wall）。'
                )
            length = _wall_length(wall)
            width = (obj.get('props') or {}).get('width') or (900 if obj_type == 'door' else 1200 if obj_type == 'window' else 900)
            if width > length:
                raise serializers.ValidationError(
                    f'{where} 的开洞宽度 {width:g} 超过所属墙长度 {length:.0f}。'
                )
            t = obj.get('t')
            if t is not None and length > 0:
                half = width / 2 / length
                if t < half or t > 1 - half:
                    raise serializers.ValidationError(
                        f'{where} 的沿墙位置 t 必须落在 [{half:.4f}, {1 - half:.4f}] 之间（洞口不能超出墙体）。'
                    )
        elif obj_type == 'beam':
            for key in ('col1', 'col2'):
                ref = obj.get(key)
                if ref in (None, ''):
                    continue
                if not isinstance(ref, str) or ref not in columns:
                    raise serializers.ValidationError(
                        f'{where} 的 {key} 必须指向本项目已有的立柱。'
                    )

    _validate_bindings(objects)


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
    for index, obj in enumerate(objects):
        if not isinstance(obj, dict):
            raise serializers.ValidationError(f'objects[{index}] 不是对象。')
        obj_id = obj.get('id')
        if not isinstance(obj_id, str) or not obj_id.strip():
            raise serializers.ValidationError(f'objects[{index}] 缺少 id。')
        if obj_id in seen_ids:
            raise serializers.ValidationError(f'objects[{index}] 的 id 重复：{obj_id}。')
        seen_ids.add(obj_id)

    _validate_objects(objects)

    if not any(isinstance(o, dict) and o.get('type') == 'cabinet' for o in objects):
        raise serializers.ValidationError('项目文件里没有任何 cabinet 对象，无法确认是机房项目。')

    meta = data.get('meta')
    if meta is not None and not isinstance(meta, dict):
        raise serializers.ValidationError('meta 必须是对象。')
    if isinstance(meta, dict):
        _number('meta', meta, 'roomHeight', '层高', 2000, 12000)
        _number('meta', meta, 'floorHeight', '架空地板高', 0, 1500)

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
            'size_bytes', 'checksum', 'uploaded_by', 'version', 'updated_by',
            'created_at', 'updated_at',
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
        uploader = self.context.get('uploader', '')
        return TwinProject.objects.create(
            name=self._resolved_name,
            description=(validated_data.get('description') or '').strip()[:255],
            project_name=parsed['project_name'],
            content=parsed['content'],
            object_count=parsed['object_count'],
            size_bytes=parsed['size_bytes'],
            checksum=parsed['checksum'],
            uploaded_by=uploader,
            updated_by=uploader,
        )


class TwinProjectUpdateSerializer(serializers.Serializer):
    """设计器保存：项目 JSON 是结构化对象，不是上传文件。

    `base_version` 是乐观锁令牌，真正比对在视图里（先用 `select_for_update()`
    锁行再比，避免校验期间内容被改）；这里声明为必填只负责类型与缺省报错。
    """

    base_version = serializers.IntegerField(min_value=1, write_only=True)
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

    def old_state(self):
        """保存前的旧内容；视图用它决定是否需要写快照。"""
        instance = self.instance
        return {
            'content': instance.content,
            'object_count': instance.object_count,
            'size_bytes': instance.size_bytes,
            'checksum': instance.checksum,
            'version': instance.version,
        }

    def apply(self, editor=''):
        """写入内容并把版本号 +1；快照由视图按 checksum 变化决定。"""
        instance = self.instance
        parsed = self.validated_data['parsed']
        instance.name = self.validated_data['name']
        if 'description' in self.validated_data:
            instance.description = (self.validated_data['description'] or '').strip()[:255]
        instance.project_name = parsed['project_name'] or instance.project_name
        instance.content = parsed['content']
        instance.object_count = parsed['object_count']
        instance.size_bytes = parsed['size_bytes']
        instance.checksum = parsed['checksum']
        instance.version = (instance.version or 0) + 1
        instance.updated_by = editor or ''
        instance.save()
        return instance


class TwinMetaUpdateSerializer(serializers.Serializer):
    """PATCH：只改名称/说明，不碰内容，不递增版本，不写快照。"""

    name = serializers.CharField(max_length=120, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)

    def validate_name(self, value):
        name = (value or '').strip()
        if not name:
            raise serializers.ValidationError('项目名称不能为空。')
        instance = self.instance
        if TwinProject.objects.exclude(pk=instance.pk).filter(name__iexact=name).exists():
            raise serializers.ValidationError(f'项目名称「{name}」已存在。')
        return name[:120]

    def update(self, instance, validated_data):
        if 'name' in validated_data:
            instance.name = validated_data['name']
        if 'description' in validated_data:
            instance.description = (validated_data['description'] or '').strip()[:255]
        instance.updated_by = self.context.get('editor', instance.updated_by)
        instance.save(update_fields=['name', 'description', 'updated_by', 'updated_at'])
        return instance


class TwinRollbackSerializer(serializers.Serializer):
    version = serializers.IntegerField(min_value=1)
