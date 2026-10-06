#!/usr/bin/env bash
#
# Tablely CD 部署脚本（§21.4「CD 细节」）
#
# 在**服务器上**执行（本地开发不要跑）；由 `.github/workflows/deploy.yml` 通过 SSH 调用，
# 也可以手工执行用于演练。它把「部署 → 健康门禁 → 失败自动回滚」收在一处，
# 避免这些步骤散落在 workflow 的 shell 片段里、演练时对不上。
#
# 做四件事（顺序即 §21.4 的顺序）：
#   ① `git reset --hard origin/main` 取到目标提交，并据此得到**镜像 tag = 短 SHA**；
#   ② `docker compose build/up`（`tablely-app:<sha>`，compose 里的 `image:` 由
#      `TABLELY_IMAGE` 注入）—— **迁移在容器启动命令内自动执行**（`prisma migrate deploy`）；
#   ③ **健康门禁**：连续 N 次探测 `/healthz` 成功才算部署成功，否则**自动回滚到上一个 tag**；
#   ④ 同步本站点的 edge 片段并热重载**共享** `edge-caddy`（配置非法时 reload 失败、旧配置继续服务）。
#
# ⚠️ 共享 edge 层的两条纪律（§21.4）：
#   · `/srv/edge` **不在本仓库内** → 回滚本应用**不会**把 edge 片段改回旧版；
#   · 片段内容没变就**不** reload，且绝不重签 `edge_caddy_data` 证书卷（Let's Encrypt 限额）。
#
# 可用环境变量覆盖（默认值即生产值）：
#   TABLELY_APP_DIR / TABLELY_IMAGE_REPO / TABLELY_HEALTH_URL
#   TABLELY_HEALTH_RETRIES / TABLELY_HEALTH_INTERVAL / TABLELY_KEEP_TAGS
#   EDGE_SITES_DIR / EDGE_CONTAINER
set -euo pipefail

APP_DIR="${TABLELY_APP_DIR:-/srv/tablely}"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
IMAGE_REPO="${TABLELY_IMAGE_REPO:-tablely-app}"
HEALTH_URL="${TABLELY_HEALTH_URL:-https://tablely.zhenjunit.com/healthz}"
HEALTH_RETRIES="${TABLELY_HEALTH_RETRIES:-12}"
HEALTH_INTERVAL="${TABLELY_HEALTH_INTERVAL:-5}"
KEEP_TAGS="${TABLELY_KEEP_TAGS:-5}"
EDGE_SITES_DIR="${EDGE_SITES_DIR:-/srv/edge/sites}"
EDGE_CONTAINER="${EDGE_CONTAINER:-edge-caddy}"
STATE_DIR="${APP_DIR}/.deploy"
HISTORY_FILE="${STATE_DIR}/history"

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy][error] %s\n' "$*" >&2; return 1; }

# 探测 /healthz：连续 HEALTH_RETRIES 次成功才返回 0（§21.5 可用性层同一入口）
wait_healthy() {
    local url="$1"
    local attempt=0
    while [ "$attempt" -lt "$HEALTH_RETRIES" ]; do
        attempt=$((attempt + 1))
        if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
            # 单次成功不算数：容器刚起时可能瞬时可用，再确认一次
            sleep "$HEALTH_INTERVAL"
            if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
                log "健康检查通过（第 ${attempt} 次）"
                return 0
            fi
        fi
        log "健康检查未通过（${attempt}/${HEALTH_RETRIES}），${HEALTH_INTERVAL}s 后重试"
        sleep "$HEALTH_INTERVAL"
    done
    return 1
}

cd "$APP_DIR"
mkdir -p "$STATE_DIR"

PREVIOUS_TAG="$(sed -n '1p' "$HISTORY_FILE" 2>/dev/null || true)"

log "拉取 main"
git fetch --prune origin main
git reset --hard origin/main
SHA="$(git rev-parse --short HEAD)"
TAG="${IMAGE_REPO}:${SHA}"
export TABLELY_IMAGE="$TAG"
# 供 docker-compose.yml 的 build.args 插值，把短 SHA 烘焙进镜像（/healthz 与日志显示它）
export APP_VERSION="$SHA"
log "目标版本 ${SHA}（镜像 ${TAG}）"

log "构建镜像（注入版本号 ${SHA}，见 docker-compose.yml 的 build.args）"
docker compose -f "$COMPOSE_FILE" build app

log "启动容器（迁移在容器启动命令内自动执行）"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

if ! wait_healthy "$HEALTH_URL"; then
    fail "新版本健康检查失败，尝试回滚"
    if [ -z "$PREVIOUS_TAG" ]; then
        fail "没有可回滚的历史 tag（这是首次部署？），请人工介入"
        exit 1
    fi
    log "回滚到 ${PREVIOUS_TAG}"
    TABLELY_IMAGE="$PREVIOUS_TAG" docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
    wait_healthy "$HEALTH_URL" || fail "回滚后仍不健康，请人工介入"
    exit 1
fi

# 只有部署成功才推进历史（history 第 1 行 = 当前 tag，供 rollback.sh 使用）
# ⚠️ 首次部署时 history 不存在 → `sed` 失败；在 `set -e` + `pipefail` 下整个管道非零会
#    **直接终止脚本**（实测导致：history 未写、无回滚点、edge 同步与镜像清理都没跑）。
#    故此处必须 `|| true`，并把条件打印写成 if。
{
    printf '%s\n' "$TAG"
    if [ -n "$PREVIOUS_TAG" ]; then
        printf '%s\n' "$PREVIOUS_TAG"
    fi
    sed -n '2,$p' "$HISTORY_FILE" 2>/dev/null || true
} | awk 'NF && !seen[$0]++' > "${HISTORY_FILE}.tmp"
mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"

# 同步 edge 片段：内容未变则不 reload（减少共享 Caddy 的扰动面）
if cmp -s "${APP_DIR}/edge/tablely.caddy" "${EDGE_SITES_DIR}/tablely.caddy"; then
    log "edge 片段无变化，跳过 reload"
else
    log "同步 edge 片段并热重载 ${EDGE_CONTAINER}"
    install -m 644 "${APP_DIR}/edge/tablely.caddy" "${EDGE_SITES_DIR}/tablely.caddy"
    docker exec "$EDGE_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
fi

# 只保留最近 KEEP_TAGS 个 tag（回滚窗口），其余镜像删除
docker images --format '{{.Repository}}:{{.Tag}}' --filter "reference=${IMAGE_REPO}:*" \
    | grep -v -F "${TAG}" \
    | tail -n +"$((KEEP_TAGS + 1))" \
    | xargs -r docker rmi >/dev/null 2>&1 || true

log "部署完成：${SHA}（回滚点 ${PREVIOUS_TAG:-无}）"
