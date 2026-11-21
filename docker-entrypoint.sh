#!/bin/sh
# serve  : サーバーを起動する (取り込みは Web の管理画面から行う)
# import : 指定 ZIP (省略時は ARCHIVE_DIR の最新) をスタンドアロンで取り込む。サーバー停止中に実行すること
set -eu

NODE="node --disable-warning=ExperimentalWarning"

latest_zip() {
  ls -1t "$ARCHIVE_DIR"/*.zip 2>/dev/null | head -n 1 || true
}

case "${1:-serve}" in
  serve)
    exec $NODE /app/src/server/main.ts
    ;;
  import)
    shift
    case "${1:-}" in
      ""|--*) zip="$(latest_zip)" ;;
      *) zip="$1"; shift ;;
    esac
    if [ -z "$zip" ]; then
      echo "[entrypoint] ERROR: 取り込む ZIP が見つかりません ($ARCHIVE_DIR)" >&2
      exit 1
    fi
    exec $NODE /app/src/import/cli.ts "$zip" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
