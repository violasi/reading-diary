#!/bin/sh
# 打 APK。一条命令做完：构建前端 → 同步进原生工程 → assembleRelease → 拷到 out/
#
# 打的是 release：debug 和 release 在 build.gradle 里用的是**同一个** signingConfigs.stable，
# 所以签名一样，照样能覆盖安装、不会丢孩子的记录（装之前脚本会再校验一次指纹）。
# release 的好处是包不带 debuggable 标志。minifyEnabled 是 false，不混淆不裁剪，
# 风险和 debug 包一样低。
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

(cd android && ./gradlew assembleRelease)

APK="out/阅读打卡日记.apk"
mkdir -p out
cp android/app/build/outputs/apk/release/app-release.apk "$APK"

# 签名指纹必须是这一个，否则装上去要先卸载 —— 那等于清空孩子的阅读记录和录音。
# 宁可在这里报错，也不要交出一个装不上去的包。
WANT=0ac9b94bb6368d698db11ebbadcb3fc2404abef41e315d856ca3e17a510243cb
APKSIGNER="$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | tail -1)"
if [ -n "$APKSIGNER" ]; then
  GOT="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null |
    sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
  if [ "$GOT" != "$WANT" ]; then
    echo "✗ 签名指纹不对，装上去会要求先卸载（记录会丢）" >&2
    echo "  期望 $WANT" >&2
    echo "  实际 ${GOT:-读不出来}" >&2
    rm -f "$APK"
    exit 1
  fi
  echo "✓ 签名指纹校验通过"
else
  echo "! 找不到 apksigner，跳过签名校验" >&2
fi

echo "✓ $APK"
ls -lh "$APK"
