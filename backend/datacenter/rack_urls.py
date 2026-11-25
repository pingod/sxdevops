from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import rack_views

router = DefaultRouter()
router.register('projects', rack_views.RackProjectViewSet, basename='rack-project')

urlpatterns = [
    path('', include(router.urls)),
]