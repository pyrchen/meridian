"""Пересобирает транскрипты, подставляя распознавание Whisper там, где оно есть.

Зачем: 37 ранних роликов канала имеют авто-субтитры YouTube без пунктуации — сплошной
поток слов, где числа и термины местами неразличимы. Whisper (medium, int8, GPU) даёт для
них связный текст с пунктуацией. Остальные 14 роликов (ноябрь 2022 и всё с мая 2025)
YouTube распознал уже качественно — их не трогаем, перезапись только добавила бы риск.

Источник каждого файла проставляется в YAML-шапке полем `source`, чтобы по любому
транскрипту было видно, чем он получен.

ВАЖНО — пишем в ОТДЕЛЬНЫЙ каталог, `transcripts/` не перезаписываем. Границы сегментов
Whisper не совпадают с границами субтитров YouTube, поэтому таймкоды абзацев сдвигаются
на единицы секунд. В справочнике и извлечениях 422 ссылки вида `файл.md [MM:SS]`, все
проверены на точное совпадение с текстом транскрипта; перезапись сдвинула бы маркеры и
тихо расстроила бы всю цепочку цитирования. Два каталога рядом решают вопрос: ссылки
остаются валидными, а более чистый текст доступен для чтения и для будущих извлечений.

    python rebuild_with_whisper.py <raw-dir> <whisper-dir> <out-dir>
"""
import json
import re
import sys
from pathlib import Path

WINDOW_S = 45  # тот же размер абзаца, что и в build_transcripts.py — таймкоды сопоставимы


def ts(ms: int) -> str:
    m, s = divmod(ms // 1000, 60)
    return f"{m:02d}:{s:02d}"


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


def from_whisper(path: Path) -> list[tuple[int, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for seg in data.get("segments", []):
        text = " ".join(str(seg.get("text", "")).split())
        if text:
            out.append((int(float(seg.get("start", 0)) * 1000), text))
    return out


def from_json3(path: Path) -> list[tuple[int, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for ev in data.get("events", []):
        if ev.get("aAppend") == 1 or "segs" not in ev:
            continue
        text = " ".join("".join(s.get("utf8", "") for s in ev["segs"]).split())
        if text:
            out.append((ev.get("tStartMs", 0), text))
    return out


def slug(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE).strip().lower()
    return re.sub(r"[\s_]+", "-", s)[:60].strip("-") or "video"


def yaml_str(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main(raw_dir: Path, whisper_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    upgraded = kept = 0

    for info_path in sorted(raw_dir.glob("*.info.json")):
        vid = info_path.name[: -len(".info.json")]
        info = json.loads(info_path.read_text(encoding="utf-8"))
        if info.get("_type") == "playlist":
            continue
        title = info.get("title", vid)
        date = info.get("upload_date", "00000000")

        wpath = whisper_dir / f"{vid}.json"
        cpath = raw_dir / f"{vid}.ru-orig.json3"

        if wpath.exists():
            lines, source = from_whisper(wpath), "whisper medium int8 (локально, GPU)"
            upgraded += 1
        elif cpath.exists():
            lines, source = from_json3(cpath), "auto-captions (ru-orig)"
            kept += 1
        else:
            print(f"  ПРОПУСК {vid}: нет ни распознавания, ни субтитров")
            continue

        if not lines:
            print(f"  ПРОПУСК {vid}: пустой результат")
            continue

        body = paragraphs(lines)
        iso = f"{date[:4]}-{date[4:6]}-{date[6:]}" if len(date) == 8 else date
        doc = (
            "---\n"
            f"video_id: {vid}\n"
            f"title: {yaml_str(title)}\n"
            f"url: https://www.youtube.com/watch?v={vid}\n"
            f"published: {iso}\n"
            f"duration_s: {info.get('duration', 0)}\n"
            f"words: {len(body.split())}\n"
            f"source: {source}\n"
            "---\n\n"
            f"# {title}\n\n"
            f"{body}\n"
        )
        (out_dir / f"{iso}-{slug(title)}.md").write_text(doc, encoding="utf-8")

    print(f"перераспознано Whisper : {upgraded}")
    print(f"оставлено на субтитрах : {kept}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
