#!/usr/bin/env python3
"""
按 plan.json 组装 .rdpkg 任务包。

只做机械活：按 plan 指定的页码取图和音频、写 manifest、打 zip。
无第三方依赖（页面图在 extract_pdf.py 里已经压好，这里不再动）。

用法：
  python3 build_pack.py <plan.json> <out_dir>
"""

import json
import shutil
import sys
import zipfile
from pathlib import Path


def build_piece(piece: dict, stage: Path, warnings: list):
    src_dir = Path(piece["source_dir"])
    probe = json.loads((src_dir / "probe.json").read_text(encoding="utf-8"))
    by_page = {p["page"]: p for p in probe["pages"]}
    pid = piece["id"]

    def take_image(pno: int, rel: str):
        info = by_page[pno]
        dest = stage / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_dir / info["image"], dest)
        return rel

    out_pages = []
    for i, pno in enumerate(piece["pages"]):
        if pno not in by_page:
            raise SystemExit(f"[{pid}] plan 里写了第 {pno} 页，但 probe.json 没有这一页")
        info = by_page[pno]

        audio_rel = None
        if info.get("audio"):
            ext = Path(info["audio"]).suffix
            audio_rel = f"audio/{pid}-s{i}{ext}"
            (stage / "audio").mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_dir / info["audio"], stage / audio_rel)

        entry = {"image": take_image(pno, f"images/{pid}-s{i}.jpg"), "audio": audio_rel}
        # text 只在没有音频、需要 TTS 时才用得上；plan 里给了就带上
        text = (piece.get("texts") or {}).get(str(pno))
        if text:
            entry["text"] = text
        out_pages.append(entry)

    # 孩子端按「这篇能不能播」分两条流程：
    #   有音频或有 text → 听一遍 → 跟读 → 录音（三关）
    #   一点都没有      → 自由浏览 → 录音（可选）（两步，亲子阅读绘本走这条）
    # 整本都没音频是正常形态，不该报警；有的页有、有的页没有才是漏了。
    n_audio = sum(1 for e in out_pages if e["audio"])
    n_text = sum(1 for e in out_pages if e.get("text"))
    if n_audio and n_audio < len(out_pages):
        missing = [pno for pno, e in zip(piece["pages"], out_pages) if not e["audio"]]
        warnings.append(
            f"[{pid}] 只有部分页有音频，缺第 {missing} 页 —— "
            f"孩子端第一关会跳过这些页，确认是故意的吗？"
        )

    out = {
        "id": pid,
        "title": piece["title"],
        "lang": piece.get("lang", "zh-CN"),
        "listen": {"mode": "sequence"},  # 第一关：依次播放各页音频，听一遍即可继续
        "pages": out_pages,
    }
    if piece.get("cover_page"):
        cp = piece["cover_page"]
        if cp in by_page:
            out["cover"] = take_image(cp, f"images/{pid}-cover.jpg")
        else:
            warnings.append(f"[{pid}] cover_page 第 {cp} 页不存在，已忽略")
    for k in ("level", "note", "source"):
        if piece.get(k):
            out[k] = piece[k]
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    stage = out_dir / f".stage-{plan['date']}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    warnings = []
    pieces = [build_piece(p, stage, warnings) for p in plan["pieces"]]

    manifest = {
        "format": "reading-diary-pack",
        "version": 1,
        "date": plan["date"],
        "child": plan.get("child", ""),
        "pieces": pieces,
    }
    if plan.get("note"):
        manifest["note"] = plan["note"]
    (stage / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    pack = out_dir / f"{plan['date']}.rdpkg"
    with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(stage))
    shutil.rmtree(stage)

    print(f"✓ {pack}  ({pack.stat().st_size / 1024:.0f} KB)")
    for p in pieces:
        n_audio = sum(1 for s in p["pages"] if s["audio"])
        n_text = sum(1 for s in p["pages"] if s.get("text"))
        flow = ("自由浏览 → 录音（可选）" if not n_audio and not n_text
                else "听一遍 → 跟读 → 录音")
        src = (f"{n_audio} 页真人音" if n_audio
               else f"{n_text} 页 TTS 文本" if n_text
               else "纯图")
        print(f"    {p['id']} {p['title']}｜{len(p['pages'])} 页｜{src}｜{flow}"
              f"{'｜含封面' if p.get('cover') else ''}")
    for w in warnings:
        print(f"  ⚠ {w}")


if __name__ == "__main__":
    main()
