"""Turn raw yt-dlp output (json3 captions + info.json) into readable markdown.

One file per video: YAML frontmatter with metadata, body as timestamped
paragraphs. Timestamps are kept so extracted claims can cite a moment in the
video rather than the video as a whole.
"""
import json
import re
import sys
from pathlib import Path

WINDOW_S = 45  # paragraph length; long enough to read, short enough to cite


def ts(ms: int) -> str:
    m, s = divmod(ms // 1000, 60)
    return f"{m:02d}:{s:02d}"


def parse_captions(path: Path) -> list[tuple[int, str]]:
    """Drop aAppend=1 continuation frames — otherwise every phrase repeats."""
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for ev in data.get("events", []):
        if ev.get("aAppend") == 1 or "segs" not in ev:
            continue
        text = " ".join("".join(s.get("utf8", "") for s in ev["segs"]).split())
        if text:
            out.append((ev.get("tStartMs", 0), text))
    return out


def paragraphs(lines: list[tuple[int, str]]) -> str:
    blocks, buf = [], []
    start = lines[0][0] if lines else 0
    for t, text in lines:
        if buf and t - start >= WINDOW_S * 1000:
            blocks.append(f"[{ts(start)}] {' '.join(buf)}")
            buf, start = [], t
        buf.append(text)
    if buf:
        blocks.append(f"[{ts(start)}] {' '.join(buf)}")
    return "\n\n".join(blocks)


def slug(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE).strip().lower()
    return re.sub(r"[\s_]+", "-", s)[:60].strip("-") or "video"


def yaml_str(v: str) -> str:
    return '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"'


def main(raw_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, skipped = [], []

    for info_path in sorted(raw_dir.glob("*.info.json")):
        vid = info_path.name[: -len(".info.json")]
        cap_path = raw_dir / f"{vid}.ru-orig.json3"
        info = json.loads(info_path.read_text(encoding="utf-8"))
        if info.get("_type") == "playlist":
            continue  # channel-level metadata dump, not a video
        title = info.get("title", vid)
        date = info.get("upload_date", "00000000")

        if not cap_path.exists():
            skipped.append((vid, title, "нет дорожки ru-orig"))
            continue

        lines = parse_captions(cap_path)
        if not lines:
            skipped.append((vid, title, "пустые субтитры"))
            continue

        body = paragraphs(lines)
        words = len(body.split())
        iso = f"{date[:4]}-{date[4:6]}-{date[6:]}" if len(date) == 8 else date
        name = f"{iso}-{slug(title)}.md"

        doc = (
            "---\n"
            f"video_id: {vid}\n"
            f"title: {yaml_str(title)}\n"
            f"url: https://www.youtube.com/watch?v={vid}\n"
            f"published: {iso}\n"
            f"duration_s: {info.get('duration', 0)}\n"
            f"words: {words}\n"
            "source: auto-captions (ru-orig)\n"
            "---\n\n"
            f"# {title}\n\n"
            f"{body}\n"
        )
        (out_dir / name).write_text(doc, encoding="utf-8")
        rows.append((iso, vid, words, info.get("duration", 0), title, name))

    total_words = sum(r[2] for r in rows)
    total_dur = sum(r[3] for r in rows)
    print(f"OK      : {len(rows)}")
    print(f"SKIPPED : {len(skipped)}")
    for vid, title, why in skipped:
        print(f"  - {vid} [{why}] {title}")
    print(f"WORDS   : {total_words}")
    print(f"HOURS   : {total_dur / 3600:.1f}")

    manifest = out_dir.parent / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "channel": "https://www.youtube.com/@SanchoDT",
                "videos": len(rows),
                "skipped": [{"id": v, "title": t, "reason": w} for v, t, w in skipped],
                "total_words": total_words,
                "total_duration_s": total_dur,
                "items": [
                    {"published": p, "video_id": v, "words": w,
                     "duration_s": d, "title": t, "file": f}
                    for p, v, w, d, t, f in sorted(rows)
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
