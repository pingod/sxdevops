from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register('credentials', views.SnmpCredentialViewSet, basename='snmp-credential')
router.register('devices', views.NetworkDeviceViewSet, basename='network-device')
router.register('interfaces', views.NetworkInterfaceViewSet, basename='network-interface')
router.register('alert-rules', views.NetworkAlertRuleViewSet, basename='network-alert-rule')
router.register('alerts', views.NetworkAlertViewSet, basename='network-alert')

urlpatterns = [
    path('overview/', views.NetworkOverviewView.as_view(), name='network-overview'),
    path('', include(router.urls)),
]