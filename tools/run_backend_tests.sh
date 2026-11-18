#!/usr/bin/env bash
# 逐个 app 串行跑后端测试，每个进程限制虚拟内存，避免单个失控用例打爆整机内存。
#
# 用法：
#   tools/run_backend_tests.sh                # 全部 app
#   tools/run_backend_tests.sh ops rbac       # 指定 app
#   MEM_LIMIT_MB=2000 tools/run_backend_tests.sh ops
set -uo pipefail

cd "$(dirname "$0")/../backend" || exit 1

PYTHON=${PYTHON:-python}
MEM_LIMIT_MB=${MEM_LIMIT_MB:-3000}
APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then
    APPS=(aiops cmdb eventwall iac multicloud network ops rbac sqlaudit)
fi

export DEBUG=${DEBUG:-1}
export SXDEVOPS_CONFIG_FILE=${SXDEVOPS_CONFIG_FILE:-config.example.sqlite.json}
export CMDB_PASSWORD_ENCRYPTION_KEY=${CMDB_PASSWORD_ENCRYPTION_KEY:-}

status=0
declare -a failed=()
for app in "${APPS[@]}"; do
    echo "=== ${app}"
    # ulimit -v 在字节数上生效；超限的进程会 MemoryError 退出而不是拖垮整机。
    if ( ulimit -v $((MEM_LIMIT_MB * 1024)); "$PYTHON" manage.py test "$app" --noinput ); then
        echo "--- ${app} OK"
    else
        echo "--- ${app} FAILED"
        failed+=("$app")
        status=1
    fi
done

if [ ${#failed[@]} -gt 0 ]; then
    echo "失败 app: ${failed[*]}"
fi
exit $status
