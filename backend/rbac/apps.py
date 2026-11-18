from django.apps import AppConfig
from django.db.models.signals import m2m_changed, post_delete, post_migrate, post_save


class RbacConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'rbac'
    verbose_name = 'RBAC 权限'

    def ready(self):
        post_migrate.connect(sync_builtin_rbac, sender=self)
        _connect_permission_cache_signals()


def sync_builtin_rbac(**kwargs):
    from .services import ensure_builtin_rbac, ensure_default_superuser

    ensure_builtin_rbac()
    ensure_default_superuser()


def _connect_permission_cache_signals():
    """任何绕过视图的角色/用户组变更也必须立刻失效权限缓存。

    视图层的显式失效只覆盖 API 路径；管理命令、种子数据、测试里的
    ORM 直改同样会改权限，靠信号才不会读到最长 60 秒的陈旧权限。
    """
    from django.contrib.auth import get_user_model

    from .models import Role, UserGroup
    from .services import invalidate_identity_permissions, invalidate_user_permissions

    def invalidate_instance(sender, instance, **kwargs):
        try:
            invalidate_identity_permissions(instance)
        except Exception:  # pragma: no cover - 缓存不可用不应阻断写入
            pass

    def invalidate_users(sender, instance, action, reverse, pk_set, **kwargs):
        if action not in {'post_add', 'post_remove', 'post_clear'}:
            return
        User = get_user_model()
        try:
            if reverse:
                # 反向关系：instance 是 User，pk_set 是 Role/UserGroup 主键
                invalidate_user_permissions(instance)
                return
            if pk_set:
                for user in User.objects.filter(pk__in=pk_set).only('id', 'username'):
                    invalidate_user_permissions(user)
            invalidate_identity_permissions(instance)
        except Exception:  # pragma: no cover
            pass

    for model in (Role, UserGroup):
        post_save.connect(invalidate_instance, sender=model, dispatch_uid=f'rbac_perm_cache_save_{model.__name__}')
        post_delete.connect(invalidate_instance, sender=model, dispatch_uid=f'rbac_perm_cache_delete_{model.__name__}')

    for field in (Role.users, Role.permissions, UserGroup.users, UserGroup.roles):
        m2m_changed.connect(
            invalidate_users,
            sender=field.through,
            dispatch_uid=f'rbac_perm_cache_m2m_{field.through._meta.label_lower}',
        )
