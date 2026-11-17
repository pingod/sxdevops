from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register('projects', views.TwinProjectViewSet, basename='twin-project')

urlpatterns = [
    path('status/', views.TwinViewerStatusView.as_view(), name='twin-viewer-status'),
    path('monitor-targets/', views.TwinMonitorTargetsView.as_view(), name='twin-monitor-targets'),
    path('', include(router.urls)),
]
