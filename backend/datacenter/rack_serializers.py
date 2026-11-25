"""机柜布设方案的内容校验与清洗。

内容口径与上游 RackDraw（Apache-2.0）的布设文件保持一致：

- `rack`：机柜规格（42U / 36U / 24U）；
- `mode`：卡位版式，`U` 按整 U 吸附，`hole` 按螺丝孔位（每 U 3 孔）微调；
- 设备坐标只用 `col`（横向 6 等分，0 起）与 `hole`（顶边孔位，自顶向下 0 起），
  U 号由孔位推导（`u = rackU - floor(hole / 3)`），不存冗余字段。

校验会拒绝越界、重复 id 与柜内重叠——编辑器本身也不允许拖出重叠方案，
进库再拦一道，避免外部脚本写进无法渲染的数据。
"""
import hashlib
import json

from rest_framework import serializers

from .models import RackProject

RACK_UNITS = {'42U': 42, '36U': 36, '24U': 24}
SNAP_MODES = ('U', 'hole')
H_GRID = 6
HOLES_PER_U = 3
DEVICE_WIDTHS = (6, 3, 2)
CATEGORIES = (
    'router', 'switch', 'firewall', 'wireless', 'small', 'monitor', 'accessory', 'custom',
)
MAX_DEVICES = 300
MAX_CUSTOM_DEVICES = 500
MAX_DEVICE_NAME = 60
MAX_NOTE = 500
MAX_CONTENT_BYTES = 4 * 1024 * 1024
MAX_CMDB_ID = 2_147_483_647

EMPTY_PROJECT = {
    'rack': '42U',
    'rackWidth': 600,
    'mode': 'U',
    'deviceSeq': 1,
    'devices': [],
    'customDevices': [],
}


def _text(value, where, label, max_len, *, required=False):
    if value is None:
        if required:
            raise serializers.ValidationError(f'{where} 的{label}不能为空。')
        return ''
    if not isinstance(value, str):
        raise serializers.ValidationError(f'{where} 的{label}必须是字符串。')
    value = value.strip()
    if required and not value:
        raise serializers.ValidationError(f'{where} 的{label}不能为空。')
    if len(value) > max_len:
        raise serializers.ValidationError(f'{where} 的{label}不能超过 {max_len} 个字符。')
    return value


def _int(value, where, label, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int):
        raise serializers.ValidationError(f'{where} 的{label}必须是整数。')
    if value < lo or value > hi:
        raise serializers.ValidationError(f'{where} 的{label}必须在 {lo}~{hi} 之间。')
    return value


def _optional_int(value, where, label, lo, hi):
    if value in (None, ''):
        return None
    return _int(value, where, label, lo, hi)


def _int_list(value, where, label):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 64:
        raise serializers.ValidationError(f'{where} 的{label}必须是最多 64 项的数组。')
    seen = set()
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item <= 0:
            raise serializers.ValidationError(f'{where} 的{label}必须是正整数数组。')
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _validate_device(index, raw, rack_u):
    where = f'devices[{index}]'
    if not isinstance(raw, dict):
        raise serializers.ValidationError(f'{where} 不是对象。')
    device_id = _int(raw.get('id'), where, 'id', 1, 10_000_000)
    cat = raw.get('cat')
    if cat not in CATEGORIES:
        raise serializers.ValidationError(f'{where} 的类别 {cat!r} 不受支持。')
    name = _text(raw.get('name'), where, '名称', MAX_DEVICE_NAME, required=True)
    width = _int(raw.get('w'), where, '宽度', 2, 6)
    if width not in DEVICE_WIDTHS:
        raise serializers.ValidationError(f'{where} 的宽度只能是 6（全宽）、3（1/2 宽）或 2（1/3 宽）。')
    height = _int(raw.get('hU'), where, '高度', 1, 24)
    col = _int(raw.get('col'), where, '横向格位', 0, H_GRID - width)
    max_hole = rack_u * HOLES_PER_U - height * HOLES_PER_U
    hole = _int(raw.get('hole'), where, '顶边孔位', 0, max_hole)
    return {
        'id': device_id,
        'cat': cat,
        'name': name,
        'w': width,
        'hU': height,
        'col': col,
        'hole': hole,
        'assetNo': _text(raw.get('assetNo'), where, '资产编号', 80),
        'serial': _text(raw.get('serial'), where, '序列号', 80),
        'owner': _text(raw.get('owner'), where, '负责人', 60),
        'note': _text(raw.get('note'), where, '备注', MAX_NOTE),
        'cmdbId': _optional_int(raw.get('cmdbId'), where, 'CMDB 资产 ID', 1, MAX_CMDB_ID),
        'cmdbIds': _int_list(raw.get('cmdbIds'), where, 'CMDB 资产 ID 列表'),
    }


def _validate_custom(index, raw):
    where = f'customDevices[{index}]'
    if not isinstance(raw, dict):
        raise serializers.ValidationError(f'{where} 不是对象。')
    device_id = _text(raw.get('id'), where, 'id', 64, required=True)
    name = _text(raw.get('name'), where, '名称', MAX_DEVICE_NAME, required=True)
    width = _int(raw.get('w'), where, '宽度', 2, 6)
    if width not in DEVICE_WIDTHS:
        raise serializers.ValidationError(f'{where} 的宽度只能是 6、3 或 2。')
    height = _int(raw.get('hU'), where, '高度', 1, 24)
    return {
        'id': device_id,
        'name': name,
        'w': width,
        'hU': height,
        'createdAt': _text(raw.get('createdAt'), where, '创建时间', 40),
    }


def _validate_no_overlap(devices):
    for left in range(len(devices)):
        a = devices[left]
        for right in range(left + 1, len(devices)):
            b = devices[right]
            if (
                a['col'] < b['col'] + b['w'] and a['col'] + a['w'] > b['col']
                and a['hole'] < b['hole'] + b['hU'] * HOLES_PER_U
                and a['hole'] + a['hU'] * HOLES_PER_U > b['hole']
            ):
                raise serializers.ValidationError(
                    f'设备「{a["name"]}」与「{b["name"]}」在机柜内占用重叠。'
                )


def parse_project(raw, *, fallback_rack='42U', name_hint=''):
    """把布设 JSON 解析成可入库字段；结构不合法直接抛 ValidationError。"""
    if raw is None:
        raw = dict(EMPTY_PROJECT)
    if not isinstance(raw, dict):
        raise serializers.ValidationError('布设内容根节点必须是对象。')

    rack = raw.get('rack') or fallback_rack
    if rack not in RACK_UNITS:
        raise serializers.ValidationError(f'不支持的机柜规格：{rack}。')
    mode = raw.get('mode') or 'U'
    if mode not in SNAP_MODES:
        raise serializers.ValidationError('卡位版式只能是 U 或 hole。')
    rack_width = _int(raw.get('rackWidth', 600), '布设内容', '机柜宽度', 400, 1200)

    raw_devices = raw.get('devices')
    if raw_devices is None:
        raw_devices = []
    if not isinstance(raw_devices, list):
        raise serializers.ValidationError('devices 必须是数组。')
    if len(raw_devices) > MAX_DEVICES:
        raise serializers.ValidationError(f'设备数 {len(raw_devices)} 超过 {MAX_DEVICES} 上限。')

    raw_custom = raw.get('customDevices')
    if raw_custom is None:
        raw_custom = []
    if not isinstance(raw_custom, list):
        raise serializers.ValidationError('customDevices 必须是数组。')
    if len(raw_custom) > MAX_CUSTOM_DEVICES:
        raise serializers.ValidationError(
            f'自定义设备数 {len(raw_custom)} 超过 {MAX_CUSTOM_DEVICES} 上限。'
        )

    devices = [_validate_device(index, item, RACK_UNITS[rack]) for index, item in enumerate(raw_devices)]
    seen_ids = set()
    for device in devices:
        if device['id'] in seen_ids:
            raise serializers.ValidationError(f'设备 id 重复：{device["id"]}。')
        seen_ids.add(device['id'])
    _validate_no_overlap(devices)

    custom_devices = [_validate_custom(index, item) for index, item in enumerate(raw_custom)]
    seen_custom = set()
    for item in custom_devices:
        if item['id'] in seen_custom:
            raise serializers.ValidationError(f'自定义设备 id 重复：{item["id"]}。')
        seen_custom.add(item['id'])

    device_seq = max([device['id'] for device in devices] + [0]) + 1
    normalized = {
        'name': (name_hint or '').strip()[:120],
        'rack': rack,
        'rackWidth': rack_width,
        'mode': mode,
        'deviceSeq': device_seq,
        'devices': devices,
        'customDevices': custom_devices,
    }
    canonical = json.dumps(normalized, ensure_ascii=False, separators=(',', ':'))
    if len(canonical.encode('utf-8')) > MAX_CONTENT_BYTES:
        raise serializers.ValidationError(
            f'布设内容超过 {MAX_CONTENT_BYTES // (1024 * 1024)}MB 上限。'
        )
    return {
        'content': canonical,
        'rack_kind': rack,
        'snap_mode': mode,
        'device_count': len(devices),
        'used_u': sum(device['hU'] for device in devices),
        'size_bytes': len(canonical.encode('utf-8')),
        'checksum': hashlib.sha256(canonical.encode('utf-8')).hexdigest(),
    }


class RackProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = RackProject
        fields = [
            'id', 'name', 'description', 'rack_kind', 'snap_mode', 'device_count',
            'used_u', 'size_bytes', 'checksum', 'uploaded_by', 'version', 'updated_by',
            'created_at', 'updated_at',
        ]
        read_only_fields = fields


class RackProjectCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    project = serializers.JSONField(required=False)

    def validate_name(self, value):
        name = (value or '').strip()
        if not name:
            raise serializers.ValidationError('方案名称不能为空。')
        if RackProject.objects.filter(name__iexact=name).exists():
            raise serializers.ValidationError(f'方案名称「{name}」已存在。')
        return name[:120]

    def validate(self, attrs):
        attrs['parsed'] = parse_project(attrs.get('project'), name_hint=self.initial_data.get('name', ''))
        return attrs

    def create(self, validated_data):
        parsed = validated_data['parsed']
        owner = self.context.get('owner', '')
        return RackProject.objects.create(
            name=validated_data['name'],
            description=(validated_data.get('description') or '').strip()[:255],
            rack_kind=parsed['rack_kind'],
            snap_mode=parsed['snap_mode'],
            content=parsed['content'],
            device_count=parsed['device_count'],
            used_u=parsed['used_u'],
            size_bytes=parsed['size_bytes'],
            checksum=parsed['checksum'],
            uploaded_by=owner,
            updated_by=owner,
        )


class RackProjectUpdateSerializer(serializers.Serializer):
    """覆盖保存：`base_version` 是乐观锁令牌，比对在视图里持锁完成。"""

    base_version = serializers.IntegerField(min_value=1, write_only=True)
    name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    project = serializers.JSONField()

    def validate(self, attrs):
        instance = self.instance
        name = (attrs.get('name') or '').strip() or instance.name
        if RackProject.objects.exclude(pk=instance.pk).filter(name__iexact=name).exists():
            raise serializers.ValidationError({'name': f'方案名称「{name}」已存在。'})
        attrs['name'] = name[:120]
        attrs['parsed'] = parse_project(attrs['project'], fallback_rack=instance.rack_kind, name_hint=name)
        return attrs

    def old_state(self):
        instance = self.instance
        return {
            'content': instance.content,
            'device_count': instance.device_count,
            'used_u': instance.used_u,
            'size_bytes': instance.size_bytes,
            'checksum': instance.checksum,
            'version': instance.version,
        }

    def apply(self, editor=''):
        instance = self.instance
        parsed = self.validated_data['parsed']
        instance.name = self.validated_data['name']
        if 'description' in self.validated_data:
            instance.description = (self.validated_data['description'] or '').strip()[:255]
        instance.rack_kind = parsed['rack_kind']
        instance.snap_mode = parsed['snap_mode']
        instance.content = parsed['content']
        instance.device_count = parsed['device_count']
        instance.used_u = parsed['used_u']
        instance.size_bytes = parsed['size_bytes']
        instance.checksum = parsed['checksum']
        instance.version = (instance.version or 0) + 1
        instance.updated_by = editor or ''
        instance.save()
        return instance


class RackMetaUpdateSerializer(serializers.Serializer):
    """PATCH：只改名称/说明，不碰内容、不递增版本、不写快照。"""

    name = serializers.CharField(max_length=120, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)

    def validate_name(self, value):
        name = (value or '').strip()
        if not name:
            raise serializers.ValidationError('方案名称不能为空。')
        instance = self.instance
        if RackProject.objects.exclude(pk=instance.pk).filter(name__iexact=name).exists():
            raise serializers.ValidationError(f'方案名称「{name}」已存在。')
        return name[:120]

    def update(self, instance, validated_data):
        if 'name' in validated_data:
            instance.name = validated_data['name']
        if 'description' in validated_data:
            instance.description = (validated_data['description'] or '').strip()[:255]
        instance.updated_by = self.context.get('editor', instance.updated_by)
        instance.save(update_fields=['name', 'description', 'updated_by', 'updated_at'])
        return instance


class RackRollbackSerializer(serializers.Serializer):
    version = serializers.IntegerField(min_value=1)