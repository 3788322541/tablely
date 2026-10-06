#!/usr/bin/env bash
#
# Tablely 回滚脚本（§21.4「回滚 = 切回上一 tag + docker compose up -d」）
#
# 在**服务器上**执行。回滚点来自 `scripts/deploy.sh` 维护的 `.deploy/history`
# （第 1 行 = 当前 tag，第 2 行 = 上一个成功部署）。
#
# 三条纪律：
#   · **不回滚数据库**：迁移强制向后兼容（两段式发布），所以旧镜像能直接跑在新库上；
#   · **不动共享 edge 层**：`/srv/edge` 不在本仓库内，回滚本应用不碰 edge 片段与证书卷；
#   · **回滚后仍过健康门禁**，否则明确报错让人工介入（不要留下半死不活的状态）。
#
# 用法：
#   scripts/rollback.sh            # 回滚到上一个成功部署的 tag
#   scripts/rollback.sh --list     # 只看可选的回滚点
#   scripts/rollback.sh <tag>      # 回滚到指定 tag（如 tablely-app:a1b2c3d）
set -euo pipefail

APP_DIR="${TABLELY_APP_DIR:-/srv/tablely}"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
IMAGE_REPO="${TABLELY_IMAGE_REPO:-tablely-app}"
HEALTH_URL="${TABLELY_HEALTH_URL:-https://tablely.zhenjunit.com/healthz}"
HEALTH_RETRIES="${TABLELY_HEALTH_RETRIES:-12}"
HEALTH_INTERVAL="${TABLELY_HEALTH_INTERVAL:-5}"
STATE_DIR="${APP_DIR}/.deploy"
HISTORY_FILE="${STATE_DIR}/history"

log() { printf '[rollback] %s\n' "$*"; }
fail() { printf '[rollback][error] %s\n' "$*" >&2; return 1; }

wait_healthy() {
    local attempt=0
    while [ "$attempt" -lt "$HEALTH_RETRIES" ]; do
        attempt=$((attempt + 1))
        if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
            log "健康检查通过（第 ${attempt} 次）"
            return 0
        fi
        sleep "$HEALTH_INTERVAL"
    done
    return 1
}

cd "$APP_DIR"

if [ ! -f "$HISTORY_FILE" ]; then
    fail "找不到 ${HISTORY_FILE}：还没有通过 scripts/deploy.sh 部署过，无回滚点"
    exit 1
fi

if [ "${1:-}" = "--list" ]; then
    log "可选回滚点（自上而下 = 由新到旧）："
    cat "$HISTORY_FILE"
    exit 0
fi

CURRENT_TAG="$(sed -n '1p' "$HISTORY_FILE")"

if [ -n "${1:-}" ]; then
    TARGET_TAG="$1"
elif [ "$(wc -l < "$HISTORY_FILE" | tr -d ' ')" -ge 2 ]; then
    TARGET_TAG="$(sed -n '2p' "$HISTORY_FILE")"
else
    fail "只有一个历史 tag（${CURRENT_TAG}），没有可回滚的上一版本"
    exit 1
fi

if [ "$TARGET_TAG" = "$CURRENT_TAG" ]; then
    fail "目标 tag 与当前 tag 相同（${CURRENT_TAG}），无需回滚"
    exit 1
fi

log "当前 ${CURRENT_TAG} → 回滚到 ${TARGET_TAG}"

if ! docker image inspect "$TARGET_TAG" >/dev/null 2>&1; then
    fail "目标镜像 ${TARGET_TAG} 不在本机（可能已被清理，见 TABLELY_KEEP_TAGS）"
    exit 1
fi

TABLELY_IMAGE="$TARGET_TAG" docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

if ! wait_healthy; then
    fail "回滚后健康检查失败，请人工介入（当前容器已是 ${TARGET_TAG}）"
    exit 1
fi

# 把目标 tag 提到 history 首位（保持「第 1 行 = 当前」的不变量）
{
    printf '%s\n' "$TARGET_TAG"
    grep -v -F -x "$TARGET_TAG" "$HISTORY_FILE" || true
} > "${HISTORY_FILE}.tmp"
mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"

log "回滚完成：${TARGET_TAG}（共享 edge-caddy 未受影响）"
