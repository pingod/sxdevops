from rest_framework.permissions import SAFE_METHODS, BasePermission, IsAuthenticated

from .services import DEMO_ACCOUNT_MUTATION_MESSAGE, is_demo_account, user_has_permissions


class RBACPermission(BasePermission):
    message = '当前用户没有执行此操作的权限。'
    required_permissions = ()

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False

        action = getattr(view, 'action', None)
        allowed_actions = set(getattr(view, 'demo_account_allowed_actions', set()) or [])
        allow_demo_write = bool(getattr(self, 'allow_demo_write', False) or getattr(view, 'demo_account_allow_write', False))
        if (
            is_demo_account(request.user)
            and request.method.upper() not in SAFE_METHODS
            and not allow_demo_write
            and action not in allowed_actions
        ):
            self.message = DEMO_ACCOUNT_MUTATION_MESSAGE
            return False

        codes = getattr(self, 'required_permissions', ())
        if not codes and hasattr(view, 'get_required_permissions'):
            codes = view.get_required_permissions()
        if codes is None:
            # 方法本身不被 view 允许时，把 405 留给框架，否则没有映射的 action 一律拒绝
            allowed_methods = {str(item).lower() for item in (getattr(view, 'http_method_names', None) or [])}
            if allowed_methods and request.method.lower() not in allowed_methods:
                return True
            self.message = f'未配置权限映射: {getattr(view, "action", None)}'
            return False
        if isinstance(codes, str):
            codes = [codes]
        if not codes:
            return True
        if user_has_permissions(request.user, codes):
            return True
        self.message = f'缺少权限: {", ".join(codes)}'
        return False


class RBACPermissionMixin:
    permission_classes = [IsAuthenticated, RBACPermission]
    rbac_permissions = {}

    def get_required_permissions(self):
        mapping = getattr(self, 'rbac_permissions', {}) or {}
        action = getattr(self, 'action', None)
        if not mapping:
            return []
        if action in mapping:
            codes = mapping[action]
        elif '*' in mapping:
            codes = mapping['*']
        else:
            return None
        if isinstance(codes, str):
            return [codes]
        return list(codes or [])


def build_rbac_permission(*codes, allow_demo_write=False):
    class ViewRBACPermission(RBACPermission):
        required_permissions = codes

    ViewRBACPermission.allow_demo_write = allow_demo_write

    return ViewRBACPermission
