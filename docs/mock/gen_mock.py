#!/usr/bin/env python3
"""生成孩子端设计稿 HTML，内嵌任务包里的真实页面图。"""
import base64, io, json, zipfile
from PIL import Image

PACK = "packs/2026-08-01.rdpkg"
OUT = "docs/mock/kid-design.html"
z = zipfile.ZipFile(PACK)
mani = json.loads(z.read("manifest.json"))


def img(path, w=340):
    im = Image.open(io.BytesIO(z.read(path))).convert("RGB")
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, "JPEG", quality=72, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()


def ultra(name, w):
    im = Image.open(f"public/images/ultraman/{name}.png").convert("RGBA")
    im.thumbnail((w, w), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()

HEROES = ["zero","tiga","taro","ginga","zeta","orb","belial","father","mother"]
U_BIG = ultra("zero", 150)
U_CAL = {n: ultra(n, 60) for n in HEROES}

P = {p["id"]: p for p in mani["pieces"]}
cover1, cover2 = img(P["p1"]["cover"], 200), img(P["p2"]["cover"], 200)
page_face = img(P["p1"]["pages"][0]["image"], 340)
page_bird = img(P["p2"]["pages"][0]["image"], 340)

BUTTERFLY = """<svg class="ic" viewBox="0 0 32 32"><g fill="currentColor">
<path d="M15 10s-9-8-11-2c-2 6 5 8 11 8z"/><path d="M17 10s9-8 11-2c2 6-5 8-11 8z"/>
<path d="M15 17s-8 1-9 6c-1 5 6 4 9-1z"/><path d="M17 17s8 1 9 6c1 5-6 4-9-1z"/>
<ellipse cx="16" cy="16" rx="1.5" ry="8.5"/></g>
<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">
<path d="M16 8.5 12.5 4.5"/><path d="M16 8.5 19.5 4.5"/></g></svg>"""

FISH = """<svg class="ic" viewBox="0 0 32 32"><g fill="currentColor">
<path d="M27 16s-4.5-7.5-11.5-7.5S6.5 11.5 5.5 16c1 4.5 3 7.5 10 7.5S27 16 27 16z"/>
<path d="M5.5 16 .8 10.8v10.4z"/></g>
<circle cx="21.5" cy="13.8" r="1.4" fill="#fff"/></svg>"""

BOLT = """<svg class="ic" viewBox="0 0 32 32"><path fill="currentColor"
d="M18.5 2 7 18h7l-2.5 12L25 13h-7.5z"/></svg>"""

STAR = """<svg class="ic" viewBox="0 0 32 32"><path fill="currentColor"
d="M16 2.5l4.2 8.9 9.8 1.3-7.2 6.7 1.8 9.7-8.6-4.7-8.6 4.7 1.8-9.7L2 12.7l9.8-1.3z"/></svg>"""

def fishtank(total, filled):
    cells = "".join(
        f'<span class="fslot{" on" if i < filled else ""}">{FISH if i < filled else ""}</span>'
        for i in range(total))
    return f'<div class="tank">{cells}</div>'

def stage_bar(active):
    ic = [("听", BUTTERFLY), ("跟读", FISH), ("录音", BOLT)]
    out = []
    for i, (lab, svg) in enumerate(ic, 1):
        state = "on" if i == active else ("done" if i < active else "")
        out.append(f'<span class="st s{i} {state}">{svg}</span>')
        if i < 3:
            out.append('<i class="arw"></i>')
    return f'<div class="stages"><span class="back">‹</span>{"".join(out)}</div>'

MARKED = {2:"zero",3:"tiga",4:"taro",8:"zero",9:"ginga",10:"zeta",11:"orb",
          15:"zero",16:"belial",17:"tiga",18:"father",19:"ginga"}
CAL_CELLS = "".join(
    f'<span class="d mark"><img src="{U_CAL[MARKED[i]]}" alt=""></span>' if i in MARKED
    else f'<span class="d">{i+1}</span>' for i in range(21))

HTML = f"""<title>阅读打卡日记 · 孩子端设计稿</title>
<style>
*{{box-sizing:border-box}}
body{{font-family:-apple-system,"PingFang SC",sans-serif;background:#f2efe9;color:#2c2925;
  margin:0;padding:26px 18px 60px}}
h1{{font-size:20px;margin:0 0 4px}}
.sub{{font-size:13px;color:#8b8377;margin-bottom:26px;line-height:1.7}}
.grid{{display:flex;flex-wrap:wrap;gap:26px;justify-content:center}}
.item{{width:344px}}
.cap{{font-size:12.5px;font-weight:700;color:#6f665a;margin:0 0 7px;text-align:center}}
.cap em{{font-style:normal;font-weight:400;color:#a49a8c}}
/* 平板竖屏机身 */
.dev{{width:344px;height:520px;background:#eaf6fb;border-radius:22px;overflow:hidden;
  box-shadow:0 3px 14px #0000001f;display:flex;flex-direction:column;position:relative}}
.ic{{width:1em;height:1em;display:block}}

/* ---------- 首页 ---------- */
.home-top{{background:linear-gradient(160deg,#1d5f8a,#2e86b8);color:#fff;padding:14px 16px 16px;
  display:flex;align-items:center;gap:12px}}
.uav{{width:74px;height:74px;flex:0 0 auto;object-fit:contain;
  filter:drop-shadow(0 3px 8px #00000040)}}
.uswap{{font-size:11px;opacity:.8;margin-top:3px;background:#ffffff2e;display:inline-block;
  padding:2px 8px;border-radius:9px}}
.uname{{font-size:12px;opacity:.85}}
.utitle{{font-size:17px;font-weight:800;margin-top:2px}}
.books{{flex:1;padding:12px;display:flex;flex-direction:column;gap:11px;overflow:hidden}}
.bk{{background:#fff;border-radius:16px;padding:10px;display:flex;gap:11px;align-items:center;
  box-shadow:0 1px 5px #0000000f}}
.bk img{{width:56px;border-radius:8px;display:block}}
.bk .t{{font-size:14px;font-weight:700;line-height:1.25}}
.bk .lv{{font-size:11px;color:#a49a8c;margin-top:2px}}
.chips{{display:flex;gap:6px;margin-top:7px;font-size:15px}}
.chip{{color:#cfc7bb}}
.chip.on{{color:#f5a524}}
.chip.fish.on{{color:#2e9fd4}}
.chip.bolt.on{{color:#d93b3b}}
.bk.done{{opacity:.62}}
.stamp{{margin-left:auto;width:40px;height:40px;border-radius:50%;border:2.5px dashed #d93b3b;
  color:#d93b3b;display:grid;place-items:center;font-size:9px;font-weight:800;
  transform:rotate(-14deg);text-align:center;line-height:1.1}}
.home-bot{{display:flex;gap:10px;padding:11px 12px 13px;align-items:stretch}}
.big-btn{{flex:1;background:#fff;border-radius:14px;padding:11px;text-align:center;
  font-size:13px;font-weight:700;box-shadow:0 1px 5px #0000000f}}
.big-btn .e{{font-size:20px;display:grid;place-items:center;margin:0 auto 2px;color:#f5a524}}
.mini{{width:62px;background:#e3ded5;border-radius:14px;display:grid;place-items:center;
  font-size:10px;color:#7d7467;font-weight:600;line-height:1.3;text-align:center}}

/* ---------- 阅读页 ---------- */
.stages{{background:#fff;padding:9px 12px;display:flex;align-items:center;gap:7px;
  box-shadow:0 1px 4px #0000000d;flex:0 0 auto}}
.back{{font-size:22px;color:#b3aa9c;margin-right:2px;line-height:1}}
.st{{font-size:19px;color:#d3cbbf;transition:.2s}}
.st.done{{color:#9fd0a8}}
.st.on{{font-size:25px}}
.st.s1.on{{color:#f5a524}}
.st.s2.on{{color:#2e9fd4}}
.st.s3.on{{color:#d93b3b}}
.arw{{flex:1;height:2px;background:#e6e0d6;border-radius:2px}}
.pageimg{{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  padding:9px;position:relative}}
.pageimg img{{max-height:100%;max-width:100%;width:auto;height:auto;object-fit:contain;
  border-radius:8px;display:block;box-shadow:0 2px 9px #00000018}}
.flyer{{position:absolute;font-size:26px;color:#f5a524}}
.actions{{background:#fff;padding:12px;flex:0 0 auto;border-top:1px solid #eee7dc}}
.play{{background:#f5a524;color:#fff;border-radius:16px;padding:17px;text-align:center;
  font-size:19px;font-weight:800;display:flex;align-items:center;justify-content:center;gap:9px}}
.play.rec{{background:#d93b3b}}
.row{{display:flex;gap:9px}}
.btn{{flex:1;border-radius:14px;padding:13px;text-align:center;font-size:14.5px;font-weight:700}}
.btn.ghost{{background:#f1ece3;color:#6f665a}}
.btn.go{{background:#2e9fd4;color:#fff}}
.btn.ok{{background:#3fae63;color:#fff}}
.tank{{display:flex;gap:4px;margin-top:10px;background:#dcf0f9;border-radius:11px;
  padding:7px 8px;justify-content:space-between}}
.fslot{{flex:1;aspect-ratio:1;border-radius:50%;background:#c4e3f1;display:grid;
  place-items:center;font-size:16px;color:#2e9fd4}}
.fslot.on{{background:#2e9fd4;color:#fff}}
.energy{{margin-top:10px;background:#f1ece3;border-radius:11px;padding:7px 9px;
  display:flex;align-items:center;gap:9px}}
.ebar{{flex:1;height:13px;background:#e0d8cb;border-radius:7px;overflow:hidden}}
.efill{{height:100%;width:62%;background:linear-gradient(90deg,#f5a524,#d93b3b)}}
.hintline{{font-size:11.5px;color:#a49a8c;text-align:center;margin-top:8px;
  display:flex;align-items:center;justify-content:center;gap:4px}}
.inline-ic{{font-size:14px;color:#f5a524;display:grid;place-items:center}}

/* ---------- 完成浮层 ---------- */
.done-ov{{position:absolute;inset:0;background:#1d5f8ae8;backdrop-filter:blur(2px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:11px;color:#fff;text-align:center;padding:24px}}
.hero{{width:132px;height:132px;object-fit:contain;
  filter:drop-shadow(0 0 22px #ff8a8ad9) drop-shadow(0 4px 10px #0006)}}
.done-ov h2{{margin:6px 0 0;font-size:21px}}
.done-ov p{{margin:0;font-size:13px;opacity:.9}}
.tally{{display:flex;gap:16px;margin-top:5px;font-size:13px;font-weight:700}}
.cal-note{{background:#ffffff26;border:2px dashed #ffffff8c;border-radius:13px;
  padding:9px 20px;font-size:12.5px;margin-top:5px}}

/* ---------- 我的 ---------- */
.me{{flex:1;overflow:hidden;padding:13px;display:flex;flex-direction:column;gap:11px}}
.sec{{background:#fff;border-radius:15px;padding:11px 12px;box-shadow:0 1px 5px #0000000f}}
.sec h3{{margin:0 0 8px;font-size:13px;color:#6f665a;display:flex;justify-content:space-between}}
.streak{{color:#a49a8c;font-weight:400;font-size:11px}}
.twonum{{display:flex;gap:18px;margin-top:4px}}
.twonum span{{font-size:10.5px;opacity:.85;display:flex;flex-direction:column}}
.twonum b{{font-size:19px;line-height:1.1}}
.cal{{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}}
.d{{aspect-ratio:1;border-radius:6px;background:#f2efe9;display:grid;place-items:center;
  font-size:11px;color:#c2b9ab}}
.d.mark{{background:#fdeed3;padding:1px}}
.d.mark img{{width:100%;height:100%;object-fit:contain}}
.starrow{{display:flex;justify-content:space-between;align-items:center;font-size:12px;
  padding:4px 0;border-top:1px solid #f4f0e8}}
.starrow:first-of-type{{border:0}}

/* ---------- 家长模式 ---------- */
.p-top{{background:#3b3630;color:#fff;padding:13px 15px;font-size:14px;font-weight:700}}
.plist{{flex:1;padding:13px;display:flex;flex-direction:column;gap:10px;background:#fbfaf8}}
.rec-row{{background:#fff;border:1px solid #eae5dd;border-radius:11px;padding:11px}}
.rec-row .tt{{font-size:13px;font-weight:700}}
.rec-row .mm{{font-size:11px;color:#9c948a;margin-top:1px}}
.rec-ctl{{display:flex;align-items:center;gap:10px;margin-top:9px}}
.pbtn{{width:34px;height:34px;border-radius:50%;background:#2e9fd4;color:#fff;
  display:grid;place-items:center;font-size:13px;flex:0 0 auto}}
.stars{{font-size:19px;letter-spacing:2px;color:#f5a524}}
.stars i{{color:#ddd6ca;font-style:normal}}
.p-note{{font-size:11px;color:#9c948a;padding:0 13px 13px;line-height:1.6}}

.note{{max-width:760px;margin:34px auto 0;background:#fff;border-radius:14px;
  padding:16px 20px;font-size:13px;line-height:1.85;color:#5d554a}}
.note b{{color:#2c2925}}
@media(prefers-color-scheme:dark){{
 body{{background:#1a1815;color:#ece7df}} .note{{background:#262320;color:#b9b2a7}}
 .note b{{color:#ece7df}} .cap{{color:#9c948a}}}}
:root[data-theme="light"] body{{background:#f2efe9;color:#2c2925}}
:root[data-theme="dark"] body{{background:#1a1815;color:#ece7df}}
</style>

<h1>阅读打卡日记 · 孩子端设计稿</h1>
<div class="sub">Android 平板竖屏｜绘本页用的是任务包里的真实素材（All Kinds of Faces / Bird Colors）<br>
抓蝴蝶 = 听　捞鱼 = 跟读　奥特曼充能 = 朗读录音　日历 = 每天陪读的那位奥特曼</div>

<div class="grid">

  <div class="item"><p class="cap">① 首页 <em>— 今天要读什么</em></p><div class="dev">
    <div class="home-top"><img class="uav" src="{U_BIG}" alt="赛罗">
      <div><div class="uname">今天陪你读的是</div><div class="utitle">赛罗奥特曼</div>
      <div class="uswap">今天就是它啦</div></div></div>
    <div class="books">
      <div class="bk"><img src="{cover1}">
        <div><div class="t">All Kinds of Faces</div><div class="lv">Level A · 8 页</div>
        <div class="chips"><span class="chip on">{BUTTERFLY}</span>
          <span class="chip fish on">{FISH}</span><span class="chip bolt">{BOLT}</span></div></div></div>
      <div class="bk"><img src="{cover2}">
        <div><div class="t">Bird Colors</div><div class="lv">Level A · 10 页</div>
        <div class="chips"><span class="chip">{BUTTERFLY}</span>
          <span class="chip">{FISH}</span><span class="chip">{BOLT}</span></div></div></div>
    </div>
    <div class="home-bot">
      <div class="big-btn"><span class="e">{STAR}</span>我的</div>
      <div class="mini">爸爸<br>妈妈</div></div>
  </div></div>

  <div class="item"><p class="cap">② 关 1 · 听一遍 <em>— 不出题，听完就能过</em></p><div class="dev">
    {stage_bar(1)}
    <div class="pageimg"><span class="flyer" style="top:14px;right:22px">{BUTTERFLY}</span>
      <img src="{page_face}"></div>
    <div class="actions"><div class="play">▶ 听故事</div>
      <div class="hintline">播放中自动翻页 · 蝴蝶飞进来</div></div>
  </div></div>

  <div class="item"><p class="cap">② 关 1 · 听完 <em>— 抓到一只蝴蝶</em></p><div class="dev">
    {stage_bar(1)}
    <div class="pageimg"><img src="{page_face}"></div>
    <div class="actions"><div class="row">
      <div class="btn ghost">🔁 再听一遍</div><div class="btn go">去跟读 →</div></div>
      <div class="hintline"><span class="inline-ic">{BUTTERFLY}</span> ×1 已收进网里</div></div>
  </div></div>

  <div class="item"><p class="cap">② 关 2 · 逐页领读 <em>— 每页捞一条鱼</em></p><div class="dev">
    {stage_bar(2)}
    <div class="pageimg"><img src="{page_bird}"></div>
    <div class="actions"><div class="row">
      <div class="btn ghost">▶ 听这页</div><div class="btn go">我读好了 →</div></div>
      {fishtank(10, 3)}</div>
  </div></div>

  <div class="item"><p class="cap">② 关 3 · 整篇录音 <em>— 能量随音量涨</em></p><div class="dev">
    {stage_bar(3)}
    <div class="pageimg"><img src="{page_face}"></div>
    <div class="actions"><div class="play rec">■ 读完了</div>
      <div class="energy">{BOLT}<div class="ebar"><div class="efill"></div></div></div>
      <div class="hintline">点一次开始、点一次结束，不用一直按着</div></div>
  </div></div>

  <div class="item"><p class="cap">② 全部读完 <em>— 变身 + 日历留影</em></p><div class="dev">
    {stage_bar(3)}
    <div class="pageimg"><img src="{page_face}"></div>
    <div class="actions"><div class="play">✓</div></div>
    <div class="done-ov"><img class="hero" src="{U_BIG}" alt="赛罗变身">
      <h2>今天读完啦！</h2><p>已经读了 23 天</p>
      <div class="tally"><span>{BUTTERFLY} ×2</span><span>{FISH} ×18</span></div>
      <div class="cal-note">日历上留下了今天的赛罗</div></div>
  </div></div>

  <div class="item"><p class="cap">③ 我的 <em>— 一页滚动，不分 tab</em></p><div class="dev">
    <div class="home-top" style="padding:12px 15px"><div><div class="uname">我的收获</div>
      <div class="twonum"><span><b>12</b>最长连续</span><span><b>23</b>总共读了</span></div></div></div>
    <div class="me">
      <div class="sec"><h3>打卡日历<span class="streak">断了不归零</span></h3>
        <div class="cal">
          {CAL_CELLS}
        </div></div>
      <div class="sec"><h3>爸爸妈妈的星星</h3>
        <div class="starrow"><span>All Kinds of Faces</span>
          <span class="stars">★★★★<i>★</i></span></div>
        <div class="starrow"><span>Bird Colors</span>
          <span class="stars">★★★★★</span></div></div>
    </div>
  </div></div>

  <div class="item"><p class="cap">④ 家长模式 <em>— 成人界面，PIN 进入</em></p><div class="dev" style="background:#fbfaf8">
    <div class="p-top">今日录音 · 2026-08-01 <span style="float:right;font-weight:400;font-size:11px;opacity:.7">PIN 默认 123</span></div>
    <div class="plist">
      <div class="rec-row"><div class="tt">All Kinds of Faces</div>
        <div class="mm">8 页 · 0:42 · 19:30 录制</div>
        <div class="rec-ctl"><div class="pbtn">▶</div><span class="stars">★★★★<i>★</i></span></div></div>
      <div class="rec-row"><div class="tt">Bird Colors</div>
        <div class="mm">10 页 · 0:55 · 19:38 录制</div>
        <div class="rec-ctl"><div class="pbtn">▶</div>
          <span class="stars"><i>★★★★★</i></span></div></div>
      <div class="rec-row" style="border-style:dashed;text-align:center;color:#9c948a;font-size:12px">
        ＋ 导入任务包（已自动发现 1 个）</div>
    </div>
    <div class="p-note">点星即存，没有「提交」按钮。<br>设置里：改 PIN（默认 <b>123</b>）· 孩子名字 · 导出备份。</div>
  </div></div>

</div>

<div class="note">
<b>为什么只有 4 个页面：</b>三关共用同一个"阅读页"壳 —— 顶部进度、中间页面图的布局完全不变，
只换底部那条操作栏。孩子学会一次就会全部三关，代码也只要一个容器组件。<br><br>
<b>孩子的主路径是一条直线：</b>首页 → 点书 → 关1 → 关2 → 关3 → 回首页，没有岔路。
「我的」是可选浏览，「爸爸妈妈」入口明显小一号且在角落。<br><br>
<b>动画只在"得到东西的那一刻"出现</b>（网住蝴蝶、鱼游进缸、能量满、变身），平时页面是安静的——
满屏乱动会抢掉孩子对绘本内容的注意力。<br><br>
<b>蝴蝶和鱼是我们自己画的内联 SVG</b>（这稿里就是），零文件零版权、离线可用、各安卓版本长得一样；
用 emoji 会因系统字体不同而变形。奥特曼是 <b>直接沿用 <code>orange_read</code> 的 9 个角色</b>（Q 版全身、透明背景，13.5 MB 压到 608 KB）。<b>打卡日历本身就是收集册</b> —— 每天读完就在格子里留下当天陪读的那位，孩子回看会看到一整墙不同的奥特曼，不需要另做一套收集物。
</div>
"""
open(OUT, "w").write(HTML)
print("→", OUT)
