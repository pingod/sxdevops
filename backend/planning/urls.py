from django.urls import path, re_path

from . import views

urlpatterns = [
    path('planning-status', views.PlanningStatusView.as_view(), name='planning-status'),
    re_path(r'^planning/(?P<engine_path>.*)$', views.PlanningProxyView.as_view(), name='planning-proxy'),
]