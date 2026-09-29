#!/usr/bin/env bash
# DUAV 一期启动脚本
#
# 用法：
#   export FH2_TOKEN='<司空 2 用户令牌>'
#   export SMTP_USER='<发件邮箱>'
#   export SMTP_PASS='<邮箱授权码>'
#   ./start.sh
#
# 说明：
#   - 先构建前端，再由 BFF 单端口托管（默认 http://127.0.0.1:8787）
#   - 授权码只从环境变量读，绝不写入本文件或任何源码
#   - SMTP_HOST 可不填，会按邮箱后缀自动推断（@163.com→smtp.163.com 等）
#   - 不配邮件也能启动，只是派发时会在界面上提示「邮件服务未配置」

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"

echo "==> 构建前端"
(cd web && npm run build)

echo "==> 启动服务 http://127.0.0.1:${PORT}"
cd server
PORT="$PORT" \
ORG_NAME="${ORG_NAME:-DUAV 低空智能监管平台}" \
PLATFORM_URL="${PLATFORM_URL:-http://127.0.0.1:${PORT}}" \
exec node src/index.js
