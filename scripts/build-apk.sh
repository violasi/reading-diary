#!/bin/sh
# 打 APK。一条命令做完：构建前端 → 同步进原生工程 → assembleDebug → 拷到 out/
#
# 为什么要有这个脚本：三步分开手动跑，很容易只跑了 npm run build 就去装 APK，
# 结果装的是上一次的前端产物。踩过一次，所以固定成一条命令。
set -e
cd "$(dirname "$0")/.."

# 本机装了多个 JDK，Capacitor 6 / AGP 8.2.1 要 17+，这里钉 21
JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export JAVA_HOME
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME

npm run build
npx cap sync android

# 校验：同步进去的前端产物必须和刚构建的 dist 一致，否则后面白装
if ! diff -q dist/index.html android/app/src/main/assets/public/index.html >/dev/null; then
  echo "✗ android assets 和 dist 不一致，cap sync 没生效" >&2
  exit 1
fi

(cd android && ./gradlew assembleDebug)

mkdir -p out
cp android/app/build/outputs/apk/debug/app-debug.apk "out/阅读打卡日记-debug.apk"
echo "✓ out/阅读打卡日记-debug.apk"
ls -lh "out/阅读打卡日记-debug.apk"
