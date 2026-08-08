---
name: reading-pack
description: 把家长手上的阅读素材（带内嵌音频的 PDF 分级读物、普通 PDF、拍的课本照片、纯文本）做成「阅读打卡日记」App 能加载的 .rdpkg 任务包。当用户说"布置今天/明天的阅读任务"、"把这个 PDF 做成任务包"、"生成 rdpkg"、"加一篇任务"，或者丢来一个绘本/读物文件时使用。
---

# 布置阅读任务 → .rdpkg

家长端不是 App，就是这个 skill。产出的 `.rdpkg` 通过网盘/微信/USB 传到孩子的安卓平板，
App 内加载后走三遍法。设计背景见 `docs/架构设计.md`。

**核心前提：绘本每页本来就印着文字，所以不抠图、不识别文字、不抄文本。**
孩子直接看整页原图，字就在图上。任务包 = 整页图 + 每页音频，别的都不需要。

## 工作流

### 1. 判断素材类型

| 素材 | 处理 |
|---|---|
| **带内嵌音频的 PDF**（RAZ / Reading A-Z 等分级读物） | 最理想，每页的真人音频和页面图都能直接抠出来 |
| **PDF + 另给一条整本 mp3**（牛津树自然拼读那批） | 页面图照常抽，音频**别切**，在 plan 里用 `book_audio` 挂整轨 → 见下方「整本一条音频」 |
| **一页 = 一个横版跨页的扫描件**（同上那批的 8 本） | 要切成左右两个单页，否则竖屏上字太小 → `--split=spread`，见下方「跨页扫描件」 |
| **亲子阅读绘本 PDF（无音频）** | 直接出页面图就行，**不用配音、不用补 `texts`**。大人念、孩子翻。⚠️ 抽图时先看下面「绘本版面陷阱」 |
| 无音频但希望机器朗读的 PDF / 课本照片 | 在 plan 里补 `texts`，朗读交给 TTS |
| 纯文本 / 家长口述一段 | 没有页面图，plan 里只给文本，App 用 TTS 朗读并显示文字 |
| 家长自己录的**整段连续**录音 | 优先直接当 `book_audio` 整轨挂上；真要切句才看「什么时候才需要 whisper」 |

### 2. 提取

```bash
uv run --quiet --with pymupdf python .claude/skills/reading-pack/scripts/extract_pdf.py <input.pdf> build/<slug>
```

产出 `build/<slug>/`：`pages/pNN.jpg`（整页图，宽 900px）、`audio/*`（每页音频，
保留 PDF 内原始命名）、`probe.json`（页码 → 图/音频/时长）。

脚本支持**两种**内嵌音频做法，RAZ 两种都在用，同一批素材里可能混着：

- **RichMedia 注释** → `/RichMediaContent` → `/Assets` → `/Names` → Filespec → `/EF`
- **Screen 注释 + Rendition** → `/A` → `/R` → `/C`(MediaClip) → `/D` → Filespec → `/EF`

**如果你确信这本有音频、脚本却报 0 页有音频，那是解析没覆盖到，不是素材没有。**
别急着当无音频素材处理，先暴力扫一遍所有流对象、按魔术字节（`ID3`、`\xff\xfb`、`RIFF`、`OggS`）
找音频，确认在不在，再照上面的链路补解析。

脚本还会交叉校验页码和音频文件名（RAZ 命名如 `_p3_text.mp3`），错位会打 ⚠。
**这个警告必须当回事** —— 页与音频错位，孩子会听着 A 页的音读 B 页的字。

### 3. 挑出正文页

`probe.json` 里是全部页，**只有正文页进 plan**。判断靠两条线索，不需要读文字：

- **音频文件名**：RAZ 这类素材命名很规整 —— `..._title_text.mp3` 是书名页，
  `..._p3_text.mp3` 是第 3 页正文
- **瞄一眼 `pages/pNN.jpg`**：封面、书名页、版权页/Photo Credits 一看就认得出来

排除封面、书名页、版权页、词汇表。封面想留就填 `cover_page`，App 拿它当书的封面展示。

### 4. 写 plan.json

写到 `plans/<日期>.plan.json`：

```json
{
  "date": "2026-08-01",
  "child": "",
  "note": "可选，写进 manifest 的备注",
  "pieces": [
    {
      "id": "p1",
      "title": "All Kinds of Faces",
      "lang": "en-US",
      "level": "RAZ Level A",
      "source": "来源说明（书名/作者），可选",
      "source_dir": "build/all-kinds-of-faces",
      "cover_page": 1,
      "pages": [3, 4, 5, 6, 7, 8, 9, 10]
    }
  ]
}
```

- **一篇 = 一本书/一段材料**，`pieces` 里放几篇就是布置几篇，篇数不限
- **一天多篇就合并进同一个包，不要一天出好几个包**：业务单位是"天"（打卡、录音回传都按天），
  孩子只需导入一次，App 也不必去拼"今天到底布置了几个包"。每篇先各自跑一次 `extract_pdf.py`
  到不同的 `build/<slug>`，然后在同一个 plan 里写多个 `pieces`，`id` 依次 `p1`/`p2`/…
  （包内文件名带 `id` 前缀，所以多篇不会串台）
- `id` 用 `p1`/`p2`/… 依次编号，会变成包内文件名前缀
- `lang`：`en-US` / `zh-CN`，只在需要 TTS 时决定音色
- `pages`：正文页页码，**顺序就是孩子读的顺序**
- `texts`：**只有该页没音频时才需要**，形如 `{"3": "This face is happy."}`，供 TTS 朗读
- `book_audio`：整本一条音频的**文件路径**（相对仓库根），见下方「整本一条音频」

### 5. 打包

```bash
python3 .claude/skills/reading-pack/scripts/build_pack.py plans/<日期>.plan.json packs
```

产出 `packs/<日期>.rdpkg`。无第三方依赖（图在上一步已压好，这里只取文件、写 manifest、打 zip）。
缺音频、缺 text 都会打 ⚠ 提示。

### 6. 汇报

告诉家长：包在哪、多大、几篇、每篇几页、多少页是真人音。有 ⚠ 就说清楚哪页会退化成 TTS。

## 孩子端给什么按钮（**没有关卡**）

孩子端是自由阅读：进书就能随便翻，听和录都是「想用再用」。给哪些按钮
**按内容自动判定**，不需要在 plan 里声明：

| 包里有什么 | 孩子端的按钮 |
|---|---|
| 逐页音频（或 `texts` 能 TTS） | 「听这页」「连着听」（连着听会自动翻页） |
| `book_audio` 整本音轨 | 「整本听」—— **翻页不会打断它**，孩子边听边自己翻 |
| 什么都没有（纯图绘本） | 只有自由翻页，大人念 |

另外首页每本书都有个耳机键「裸听」：不进故事页，就在首页把整本放完。

## 整本一条音频（`book_audio`）

有的素材是「PDF 一本 + mp3 一条」，音频和页码对不上。**别切。**

牛津树自然拼读那批就是典型：一条 2 分钟的 mp3 里混着拼读练习和故事、
逐音停顿，按静音切出来 30~41 段，而书只有 9 页 —— 硬切只会切碎。

plan 里这样写，脚本会把这条音频原样搬进包、写成 `listen: {mode:"whole", audio:…}`：

```json
{
  "id": "p1",
  "title": "The Fizz-buzz",
  "lang": "en-GB",
  "source_dir": "build/ox-01-the-fizz-buzz",
  "cover_page": 1,
  "pages": [2, 4, 5, 6],
  "book_audio": "2/2.01.The Fizz-buzz.mp3"
}
```

⚠️ **拼读读物的「拼读要点页」必须带上**（印着 Focus phonics / Say the sounds
那一页），放在 `pages` **最前面** —— 孩子读之前要先过一遍这些音。
横版跨页那批切完之后它是 probe 第 2 页；Jack/Quiz 那种竖版也是第 2 页。
有的扫描件压根没有这一页（如 A Robin's Eggs），那就没有，别硬凑。

## 跨页扫描件（`--split=spread`）

一页 PDF = 一个物理跨页 = **两个书页**并排，四周还有大片白边。整张塞进竖屏平板，
每个书页只占半个屏宽，字小到读不了。

```bash
uv run --quiet --with pymupdf python .claude/skills/reading-pack/scripts/extract_pdf.py \
  <跨页扫描.pdf> build/<slug> --split=spread --width=800
```

按正中切两半、各自裁掉白边、自动丢掉空白的那半（末页常是「左空白 + 右一页」）。
页号 = PDF 第 N 页 → 左半 `2N-1`、右半 `2N`，**不重排**，所以 probe 的页号
永远能反推回原 PDF 的哪一页哪半边。切完先瞄几张图确认版式，再挑正文页。

## 绘本版面陷阱（做绘本前必读）

很多亲子绘本 PDF 不是「一页一张图」，而是**一张高清跨页扫图 + 一段转录文字，拼在 A4 横版里**，
四周大片空白、还印着大号页码。这类 PDF 直接用默认模式抽图会踩两个坑：

1. **插图被压小**。默认按页面宽度缩放整页渲染，高清跨页图（常见 2300+ px）会被压到几百像素，
   孩子在平板上看不清细节。
2. **文字被吞掉**。这类 PDF 常用子集化的 CJK 内嵌字体（如 `MPDFAA+HiraginoSansGBW3`，
   Type0/Identity-H）。MuPDF 解不开字形映射，整段 36pt 的正文会渲染成**空白或错字** ——
   产出的页面图看起来就像「原文的大字被删掉了」。而 `page.get_text()` 其实能把文字完整读出来，
   所以这是渲染问题，不是缺文本。

**判断方法**：抽完图一定要打开一两页看看，别只看脚本打印的页数。同时可以先探一探：

```bash
uv run --quiet --with pymupdf python -c "
import fitz; d=fitz.open('某绘本.pdf')
for i in (2,3):
    p=d[i]
    print(i+1, '文本', len(p.get_text().strip()), '字体', [f[3] for f in p.get_fonts()],
          '内嵌图', [(im[2],im[3]) for im in p.get_images()], '页面', [round(v) for v in p.rect])
"
```

看到「有文本 + 内嵌图远大于页面尺寸」就用绘本模式：

```bash
uv run --quiet --with pymupdf python .claude/skills/reading-pack/scripts/extract_pdf.py \
  "某绘本.pdf" build/some-book --layout=picturebook --width=1400
```

它会取内嵌插图的**原始像素**，再用 PyMuPDF 自带的 `china-s` 字体把 `get_text()` 的文字
重新排在图下面（字号 = 输出宽度 / 26，按孩子一臂距离校的），不依赖系统字体。

注意这样出的包会明显变大（扫描图细节多、压不下去，1400px 每页约 700 KB，
15 页的绘本约 10 MB）。本地传输和平板存储都没问题，不用为此牺牲清晰度。

纯图绘本的任务包只要**整页图**就够了。别为了凑出个「听」的按钮去硬配音或硬补文本 ——
亲子阅读本来就是大人念给孩子听，机器朗读中文绘本只会碍事。

⚠️ 别出「一半页有音频、一半没有」的包：「连着听」会静音跳过缺音频的那些页。
`build_pack.py` 遇到这种情况会警告。

## 什么时候才需要 whisper

绝大多数情况**不需要**，别随手就去下模型。

**整本一条音频不是理由** —— 用 `book_audio` 原样挂上就行，孩子端有「整本听」，
边听边自己翻页。以前这里写着「整本一条就得切」，那是关卡时代的遗留，已经不对了。
拼读类音频尤其不能切：它逐音停顿，静音切出来的段数是页数的三四倍。

真正还需要切的只剩一种：家长念了**一整段连续录音**，且明确要求逐页对齐领读。

真需要时（本机已有 `whisper-cli` 和 `ffmpeg`，但**模型要先下**，中文建议 `ggml-small`）：

```bash
whisper-cli -m <模型> -l <zh|en> -oj -vsd 300 <audio>   # -oj 出带时间戳的 JSON
```

再用 `ffmpeg -ss/-to` 按时间戳切片。分级读物那种每页 1~2 秒一条的音频，
粒度本来就等于「一页一句」，直接用，不要多此一举。

## 注意

- 任务包里含有版权素材，只在家长本机和孩子平板之间传递，不要做分享/上传功能
- `build/` 是可从原始 PDF 重新生成的中间产物，不必长期保留；`plans/` 留着便于改一处就重打包
