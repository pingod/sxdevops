"""项目统一分页配置。

DRF 默认的 ``PageNumberPagination`` 不识别 ``page_size`` 查询参数，前端若按
``?page_size=200`` 期望拿到全量列表，实际只会得到第一页（默认 20 条），
并且多数列表页没有分页控件，最终表现为数据被静默截断。这里统一开启
``page_size``（上限 1000），保持响应结构 ``count/next/previous/results`` 不变。
"""
from rest_framework.pagination import PageNumberPagination


class StandardPagination(PageNumberPagination):
    page_size_query_param = 'page_size'
    max_page_size = 1000
