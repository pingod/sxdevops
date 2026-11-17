"""三维机房项目：只读查看器加载的 DCDesigner 项目 JSON。

查看器（`tools/dc-viewer`，独立 Vite 应用）只负责渲染，平台侧只负责项目文件的
托管与权限，不做几何解析——渲染口径只有一份实现，避免两侧各拍一套尺寸。

项目 JSON 落库（TextField）而不是文件系统：单个文件几 MB、纯文本、容器部署没有
可持久化的 `MEDIA_ROOT`，落库后备份、迁移、回滚与数据库同源，不会出现
「库回滚了、文件还在」的错位。
"""
from django.db import models


class TwinProject(models.Model):
    name = models.CharField('项目名称', max_length=120, unique=True)
    description = models.CharField('说明', max_length=255, blank=True, default='')
    project_name = models.CharField('数据内项目名', max_length=120, blank=True, default='')
    content = models.TextField('项目 JSON')
    object_count = models.PositiveIntegerField('对象数', default=0)
    size_bytes = models.PositiveIntegerField('文件字节数', default=0)
    checksum = models.CharField('SHA-256', max_length=64, blank=True, default='')
    uploaded_by = models.CharField('上传人', max_length=150, blank=True, default='')
    version = models.PositiveIntegerField('内容版本', default=1)
    updated_by = models.CharField('最后修改人', max_length=150, blank=True, default='')
    created_at = models.DateTimeField('创建时间', auto_now_add=True)
    updated_at = models.DateTimeField('更新时间', auto_now=True)

    class Meta:
        verbose_name = '三维机房项目'
        verbose_name_plural = '三维机房项目'
        ordering = ['-updated_at', '-id']

    def __str__(self):
        return self.name


class TwinProjectSnapshot(models.Model):
    """内容快照：每次覆盖保存前留一份旧内容，用于回滚与追责。

    保留最近 `SNAPSHOT_KEEP` 个版本，更早的随写入裁剪；content 与主表同为
    TextField，几 MB 量级在 SQLite/PostgreSQL 上都不需要额外对象存储。
    """

    SNAPSHOT_KEEP = 30

    project = models.ForeignKey(
        TwinProject, on_delete=models.CASCADE, related_name='snapshots', verbose_name='项目',
    )
    version = models.PositiveIntegerField('版本号')
    content = models.TextField('项目 JSON')
    object_count = models.PositiveIntegerField('对象数', default=0)
    size_bytes = models.PositiveIntegerField('文件字节数', default=0)
    checksum = models.CharField('SHA-256', max_length=64, blank=True, default='')
    created_by = models.CharField('保存人', max_length=150, blank=True, default='')
    created_at = models.DateTimeField('创建时间', auto_now_add=True)

    class Meta:
        verbose_name = '三维机房项目快照'
        verbose_name_plural = '三维机房项目快照'
        ordering = ['-version']
        constraints = [
            models.UniqueConstraint(fields=['project', 'version'], name='twin_snapshot_project_version_unique'),
        ]

    def __str__(self):
        return f'{self.project_id} v{self.version}'
