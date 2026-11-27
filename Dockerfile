ARG REGISTRY_MIRROR=docker.m.daocloud.io/library/
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${REGISTRY_MIRROR}node:20-alpine AS frontend-builder

ARG NPM_REGISTRY

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci

COPY frontend/ ./
RUN npm run build


FROM ${REGISTRY_MIRROR}node:22-alpine AS planning-web-builder

ARG NPM_REGISTRY

WORKDIR /app/planning/web

RUN corepack enable \
    && COREPACK_NPM_REGISTRY=${NPM_REGISTRY} corepack prepare pnpm@11.27.0 --activate \
    && pnpm config set registry ${NPM_REGISTRY}

COPY planning/web/package.json planning/web/pnpm-lock.yaml planning/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY planning/web/ ./
RUN VITE_BASE=/planning-app/ VITE_API_BASE=/api/planning pnpm build


FROM ${REGISTRY_MIRROR}node:22-alpine AS dc-viewer-builder

ARG NPM_REGISTRY

WORKDIR /app/tools/dc-viewer

COPY tools/dc-viewer/package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci

COPY tools/dc-viewer/ ./
RUN npm run build


FROM ${REGISTRY_MIRROR}node:22-alpine AS dc-designer-builder

ARG NPM_REGISTRY

WORKDIR /app/tools

COPY tools/dc-viewer/package*.json ./dc-viewer/
COPY tools/dc-designer/package*.json ./dc-designer/
RUN npm config set registry ${NPM_REGISTRY} \
    && cd dc-viewer && npm ci \
    && cd ../dc-designer && npm ci

COPY tools/dc-viewer/ ./dc-viewer/
COPY tools/dc-designer/ ./dc-designer/
# prebuild 会先构建 dc-viewer 并复制到 public/inspect，再构建设计器本体
RUN cd dc-designer && npm run build


FROM ${REGISTRY_MIRROR}python:3.12-slim AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ARG KUBECTL_PACKAGE_VERSION=1.32.3+ds-2
ARG DEBIAN_MIRROR=mirrors.aliyun.com

WORKDIR /app

# 系统依赖与 kubectl 单独一层：改 requirements.lock.txt 不会重跑 apt。
# 默认使用国内 Debian 镜像，可通过 --build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn 覆盖。
RUN set -eux; \
    sed -i \
        -e "s|http://deb.debian.org/debian-security|https://${DEBIAN_MIRROR}/debian-security|" \
        -e "s|http://deb.debian.org/debian|https://${DEBIAN_MIRROR}/debian|" \
        /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates bash bash-completion sshpass \
        kubernetes-client=${KUBECTL_PACKAGE_VERSION}; \
    kubectl version --client; \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /app/backend/requirements.txt
COPY backend/requirements.lock.txt /app/backend/requirements.lock.txt

# IDC 上架布线引擎（vendored，MPL-2.0，见 planning/NOTICE.md）。
# 依赖版本由引擎自己的 pyproject [serve] 钉死；运行时监管进程以
# /app/planning/backend 为 cwd 启动 uvicorn，导入的是这份源码树。
COPY planning/backend/pyproject.toml /app/planning/backend/pyproject.toml
COPY planning/backend/idcbox/ /app/planning/backend/idcbox/

# 安装与清理必须同一层：删除动作放在新层只会新增一个“白化”层，镜像体积不会减小。
# 移除项：pip、ansible-test、类型存根、kubernetes/aio、.pyc 与 tests 目录，
# 运行时用不到的 CPython 工具（ensurepip/idlelib/tkinter/lib2to3/turtledemo），
# 以及 site-packages 内扩展模块的调试符号。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends binutils; \
    pip install --no-cache-dir -r /app/backend/requirements.lock.txt; \
    pip install --no-cache-dir "/app/planning/backend[serve]"; \
    SP=/usr/local/lib/python3.12/site-packages; \
    rm -rf $SP/pip $SP/pip-*.dist-info $SP/wheel $SP/wheel-*.dist-info; \
    rm -rf $SP/ansible_test $SP/ansible_test-*.dist-info; \
    rm -rf $SP/kubernetes/aio; \
    find $SP -name "*.pyi" -delete; \
    find $SP -type d -name tests -prune -exec rm -rf {} + || true; \
    find $SP -name "__pycache__" -type d -prune -exec rm -rf {} + || true; \
    find $SP -type f -name "*.so" -exec strip --strip-unneeded {} + || true; \
    rm -rf /usr/local/lib/python3.12/ensurepip /usr/local/lib/python3.12/idlelib \
        /usr/local/lib/python3.12/tkinter /usr/local/lib/python3.12/lib2to3 \
        /usr/local/lib/python3.12/turtledemo /usr/local/lib/python3.12/test; \
    apt-get purge -y binutils; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /root/.cache

COPY LICENSE /app/LICENSE
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md
COPY licenses/ /app/licenses/
COPY backend/ /app/backend/
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
COPY planning/LICENSE planning/NOTICE.md /app/planning/
COPY planning/data/idcbox.db /app/planning/data/idcbox.db
COPY planning/rules/ /app/planning/rules/
COPY planning/projects/ /app/planning/projects/
COPY planning/信息港部署上架/ /app/planning/信息港部署上架/
COPY --from=planning-web-builder /app/planning/web/dist /app/planning/web/dist
COPY --from=dc-viewer-builder /app/tools/dc-viewer/dist /app/tools/dc-viewer/dist
COPY --from=dc-designer-builder /app/tools/dc-designer/dist /app/tools/dc-designer/dist
COPY docker/entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /app/backend

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "daphne", "-b", "0.0.0.0", "-p", "8000", "sxdevops.asgi:application"]
