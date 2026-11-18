#!/usr/bin/env bash
# 按模块串行跑测试并逐行输出结果，避免一次性加载整套测试。
# 用法: run_test_modules.sh <label> <mem_mb> <module1> [module2 ...]
set -uo pipefail
LABEL=$1; shift
MEM=$1; shift
cd "$(dirname "$0")/../backend" || exit 1
export DEBUG=1
export SXDEVOPS_CONFIG_FILE=${SXDEVOPS_CONFIG_FILE:-config.example.sqlite.json}
fail=0
for m in "$@"; do
    out=$( (ulimit -v $((MEM * 1024)); timeout 600 "$PYTHON" manage.py test "$m" --noinput 2>&1) )
    code=$?
    summary=$(printf '%s' "$out" | grep -E '^Ran |^OK|^FAILED' | tr '\n' ' ')
    errors=$(printf '%s' "$out" | grep -cE '^(ERROR|FAIL): ')
    printf '%s %s [exit=%s errors=%s] %s\n' "$LABEL" "$m" "$code" "$errors" "$summary"
    [ "$code" -ne 0 ] && fail=1
done
exit $fail
