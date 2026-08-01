# 阅读打卡日记

家长在 Mac 上用 skill 把阅读素材做成任务包，传到孩子的安卓平板，孩子按流程读完，家长听录音打星。
有声音的分级读物走三遍法，纯图的亲子阅读绘本走「自由浏览 + 可选录音」。
**零后端、零云服务、永久免费。**

设计文档：[技术调研](docs/技术调研.md)｜[架构设计](docs/架构设计.md)｜[孩子端设计](docs/孩子端设计.md)｜[设计稿](docs/mock/kid-design.html)

## 跑起来

```bash
npm install && npm run dev
```

打开 http://localhost:5181 。首次进入没有任务包，点右下角「爸爸妈妈」选一个 `.rdpkg` 导入。

### 关于素材

仓库里**不含任何版权素材**：绘本/分级读物的 PDF、打好的 `.rdpkg`、以及奥特曼立绘都没有入库。

陪读角色的图请自备，放到 `public/images/ultraman/`，文件名对应 `src/data/heroes.ts`
里的 id（默认只用到 `taro.png`）。**缺图不影响使用** —— App 会静默降级，不会显示碎图标。

阅读素材同理：把自己的 PDF 放在项目根目录，按下面的流程出任务包。

## 家长端：出任务包

不是 App，是一个 Claude Code skill。详见 [SKILL.md](.claude/skills/reading-pack/SKILL.md)。

```bash
# 1. 从 PDF 抠每页音频 + 渲染整页图
uv run --quiet --with pymupdf python .claude/skills/reading-pack/scripts/extract_pdf.py "某本书.pdf" build/some-book
# 2. 写 plans/<日期>.plan.json（挑正文页），然后打包
python3 .claude/skills/reading-pack/scripts/build_pack.py plans/2026-07-31.plan.json packs
```

一天一个包，一本书一个 `piece`，篇数不限。

## 目录

```
src/
  App.tsx            视图切换 + 当天数据加载（没用路由库，4 个屏一条直线）
  types.ts           .rdpkg 格式与进度类型
  lib/db.ts          IndexedDB（idb-keyval），键约定见文件头
  lib/pack.ts        解 .rdpkg → 校验 manifest → 落库；object URL 生命周期
  pages/Home         今日书单 + 三关进度 + 导入
  pages/Read         阅读页壳：三关 / 两步两条流程都在这里
  pages/Review       复习模式（书架进入，不计打卡）
  pages/Shelf        我的书架：全部导入过的书，按书名去重
  pages/Parent       家长模式：听录音打星、导入、维护
  lib/recorder.ts    MediaRecorder + 实时音量（能量槽）
  lib/back.ts        安卓返回键拦截（录音中不许误退）
  components/Icons   蝴蝶/鱼/能量/星，全部内联 SVG（不用 emoji）
  data/heroes.ts     固定泰罗（图仍是全套 9 个，换角色改一行）
```

## 上平板用

### 方式一：装 APK（推荐，录音最稳）

已经打好了：`out/阅读打卡日记-debug.apk`（约 4.5 MB）。用数据线连上平板后：

```bash
~/Library/Android/sdk/platform-tools/adb install -r "out/阅读打卡日记-debug.apk"
```

或者把 apk 拷到平板上直接点开装（要先允许「未知来源」）。已锁竖屏，
`RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` 都声明好了，首次录音时系统会弹一次权限。

重新打包 —— **一条命令，别手动分步跑**：

```bash
npm run apk
```

`scripts/build-apk.sh` 会依次做完 构建前端 → `cap sync` → `assembleDebug` → 拷到 `out/`，
中间还会校验同步进原生工程的产物和 `dist` 一致。分步手动跑最容易只执行了
`npm run build` 就去装 APK，装到的其实是上一次的前端产物（踩过一次）。

构建注意（都已配好，写下来免得以后踩）：
- 本机没有 cmdline-tools，装不了新 SDK 组件，所以钉在 `compileSdk 34` + `build-tools 34.0.0`
- Gradle wrapper 指向本机已有的 **8.14.3**，不用再下 Capacitor 默认的 8.2.1（200 MB）
- `android/build.gradle` 里给**顶层和所有子工程**都配了阿里云镜像。
  少了子工程那一段，`capacitor-android` 会直连 `dl.google.com`，国内网络下
  常在 TLS 握手就被掐断（实测就是这么失败的）

### 方式二：静态托管（⚠️ 必须 HTTPS）

**录音需要安全上下文。** `http://` 的局域网地址（`http://192.168.x.x:5181`）在 Chrome 里
不算安全上下文，`getUserMedia` 会被直接拒绝 —— 关 1、关 2 能用，**关 3 录音一定失败**。
所以别走局域网 http。可行的三条路：

`npm run build` → 把 `dist/` 拖到 EdgeOne Pages / Vercel / Cloudflare Pages，拿到
https 地址，平板 Chrome 打开、加到主屏。数据全在平板本地 IndexedDB，托管方只发静态文件。

临时调试也可以用 Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
把局域网地址加进白名单（每台设备手动配一次）。

构建用了 `base: './'`（相对路径），部署到任何子路径都不会白屏。

## 进度

- [x] 导入 `.rdpkg`（校验 manifest、只取被引用的文件、缺文件报错、日期不是今天会明确提示）
- [x] 陪读奥特曼固定泰罗（去掉了每天挑一个的页面）
- [x] 首页：书单、封面、进度点亮（三关 3 点 / 两步 2 点）、读完锁卡
- [x] 两条流程按内容自动判定：有声音走三关，纯图绘本走「自由浏览 → 录音（可选）」两步
- [x] 关 1 听一遍：顺序播全篇、自动翻页、听完停在「再听一遍 / 去跟读」
- [x] 关 2 逐页领读：听这页（可反复）、我读好了、鱼缸进度
- [x] 关 3 录音：点击开始/结束、能量槽随音量、试听、重录、交给家长 → 奥特曼变身
- [x] 「我的」页：打卡日历 + 最长连续/总天数 + 星星
- [x] 家长模式：PIN（默认 `123`）、听录音、点星即存、导入任务包、改密码
- [x] 进度、录音、星星全部落盘，刷新不丢
- [x] 「我的书架」：所有导入过的书按书名去重（同名取最新），复习模式不录音、不写进度
- [x] 家长维护：清空今天 / 全部清零（打字确认，只清记录不动书）、手动清理已评分旧录音（带占用显示）
- [x] 打卡章按「当天全部读完」盖（绘本浏览完即算，录音可选）
- [x] 跨零点自动切到新一天（回前台 + 每分钟兜底）
- [x] Capacitor 打 APK、锁竖屏、接安卓返回键
- [ ] 自动扫描下载目录发现新任务包（需 Capacitor Filesystem）

## 注意

- **阅读页中部的图片容器必须 `min-h-0`**（配 `object-contain`）。flex 子项的自动最小高度由内容决定，
  整页图会撑着不缩、溢出被裁 —— 裁掉的正好是页面底部那行字，而那行字就是孩子要读的内容。
- 关卡状态样式**别用 `nth-of-type`**：返回箭头也是同类元素，会把序号顶掉一位。
- `packs/`、`build/`、`*.pdf`、`public/images/ultraman/`、`android/`、`out/` 都不入库
  （版权素材 / 可重新生成）。缺奥特曼图时走 `HeroImg` 的降级分支。
- **录音不会自动删。** 早先做过「评分后自动清理」，后来去掉了 —— 孩子的声音
  不该被 App 悄悄删掉。App 占地方变慢了，家长页「维护」里手动清（那里显示
  当前一共存了多少段、多大）。只清往日已评分的，今天的一律保留：家长可能
  刚打了分又想重听改分。
- 没做导出/备份 —— 单设备场景用不上，而且没有配套的导入，导出只会是个假的迁移。
- APK 里 `allowBackup="false"` 且排掉了 device-transfer：录音和 PIN 不该跟着
  任何系统自动流程走（这个项目的前提是零云服务）。
- 想复习旧书从「我的书架」进，走的是 `Review` 页：**不录音、不写进度**，免得复习污染当天打卡。
- **书架按书名去重**，同名以最新导入的为准 —— 一本书常要看好几天，每天的包里都有它，
  书架上却只该有一本。注意 `Map.set` 覆盖已有键时保留的是初次插入位置，所以必须显式按日期排序。
- **打卡章的判定集中在 `updateProgress` 里**，不要挂在某个按钮上：纯图绘本的录音是可选的，
  孩子可能根本不点录音，那条路上也得能盖章。
