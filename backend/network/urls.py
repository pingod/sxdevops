from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register('credentials', views.SnmpCredentialViewSet, basename='snmp-credential')
router.register('devices', views.NetworkDeviceViewSet, basename='network-device')
router.register('interfaces', views.NetworkInterfaceViewSet, basename='network-interface')

urlpatterns = [
    path('overview/', views.NetworkOverviewView.as_view(), name='network-overview'),
    path('', include(router.urls)),
]