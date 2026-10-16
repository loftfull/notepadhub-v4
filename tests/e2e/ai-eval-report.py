"""Builds docs/eval/REPORT.md from the *.jsonl files written by ai-eval-e2e.mjs (one file per model).
Usage: python -I tests/e2e/ai-eval-report.py <eval dir> <corpus dir> <out.md>
Checks are mechanical, so every number can be recomputed from the files:
- done: the task produced an answer (no error);
- fix: typos repaired (good word present, bad word gone) and the rest of the text kept (word overlap with the source);
- shorten: the answer is shorter than the source;
- insight: a real answer, not a copy of the source (overlap with the source below 80 %);
- custom: a non-empty answer;
- structure: the sheet changed and one Ctrl+Z restored it;
- apply/undo: Apply changed the sheet and Ctrl+Z brought the note back.
"""
import json
import re
import statistics
import sys
from pathlib import Path

eval_dir, corpus_dir, out_path = (Path(a) for a in sys.argv[1:4])
KEYS = {"A": "A_cat", "B": "B_internet", "C": "C_borscht", "D": "D_solar", "E": "E_ai", "F": "F_coffee"}


def words(text):
    return re.findall(r"[\w]+", text.lower().replace("́", ""))


def overlap(a, b):
    """Share of the words of a that are found (as a bag) in b."""
    bag = {}
    for w in words(b):
        bag[w] = bag.get(w, 0) + 1
    kept = 0
    wa = words(a)
    for w in wa:
        if bag.get(w, 0) > 0:
            kept += 1
            bag[w] -= 1
    return kept / max(1, len(wa))


def load(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


rows = []
for jl in sorted(eval_dir.glob("*.jsonl")):
    typos = {}
    tp = Path(str(jl) + ".typos.json")
    if tp.exists():
        typos = json.loads(tp.read_text(encoding="utf-8"))
    recs = load(jl)
    res = {"name": jl.stem, "n": len(recs), "errors": 0, "secs": [], "checks": {}, "details": []}
    for r in recs:
        if r.get("seconds") is not None:
            res["secs"].append(r["seconds"])
        key = KEYS[r["letter"]]
        clean = (corpus_dir / (key + ".txt")).read_text(encoding="utf-8")
        label = r.get("label", "")
        out = r.get("output") or ""
        verdict = None
        note = ""
        if r.get("error"):
            res["errors"] += 1
            verdict, note = False, "ошибка: " + r["error"][:70]
        elif label == "Структурировать":
            verdict = bool(r.get("sheetChanged")) and bool(r.get("undoRestored"))
            note = "изменено=%s, отмена=%s" % (r.get("sheetChanged"), r.get("undoRestored"))
        elif r.get("typo") and label == "Исправить":
            src = typos.get(r["letter"], {})
            ts = src.get("typos", [])
            fixed = sum(1 for t in ts if t["good"].lower() in out.lower() and t["bad"].lower() not in out.lower())
            keep = overlap(src.get("text", clean), out)
            verdict = bool(ts) and fixed / len(ts) >= 0.8 and keep >= 0.9
            note = "исправлено %d из %d, сохранено слов %d%%" % (fixed, len(ts), round(keep * 100))
        elif label == "Сжать":
            verdict = 0 < len(out) < r.get("sourceChars", 10**9) * 0.85
            note = "длина %d%% от исходной" % round(100 * len(out) / max(1, r.get("sourceChars", 1)))
        elif r.get("kind") == "insight":
            ov = overlap(out, clean)
            verdict = len(out) > 80 and ov < 0.8 and not r.get("truncated")
            note = "%d знаков, совпадение с исходным %d%%%s" % (len(out), round(ov * 100), ", оборван" if r.get("truncated") else "")
        elif r.get("kind") == "custom":
            verdict = len(out.strip()) > 20
            note = "%d знаков" % len(out)
        else:
            ov = overlap(clean, out) if out else 0
            verdict = len(out) > 100
            note = "%d знаков" % len(out)
        res["details"].append((r["id"], r["label"], verdict, note, r.get("seconds")))
        kind = "structure" if label == "Структурировать" else ("fix" if label == "Исправить" else ("shorten" if label == "Сжать" else r.get("kind", "other")))
        c = res["checks"].setdefault(kind, [0, 0])
        c[1] += 1
        c[0] += 1 if verdict else 0
        if r.get("applied") and label != "Структурировать":
            c2 = res["checks"].setdefault("apply+undo", [0, 0])
            c2[1] += 1
            c2[0] += 1 if (r.get("sheetChanged") and r.get("undoRestored")) else 0
    rows.append(res)

lines = ["# Отчёт о проверке моделей ИИ на настоящих текстах", "", "Данные: `docs/eval/*.jsonl`, скрипт `tests/e2e/ai-eval-e2e.mjs`, разбор `tests/e2e/ai-eval-report.py`. Каждое задание идёт через окно программы: выбор действия, ответ модели, «Применить», проверка листа, Ctrl+Z.", ""]
lines += ["## Итог по моделям", "", "| Модель | Заданий | Ответ получен | Исправление опечаток | Сжатие | Выводы (инсайты) | Своя инструкция | Структурировать | Применить и отменить | Медиана, с |", "|---|---|---|---|---|---|---|---|---|---|"]


def cell(res, kind):
    c = res["checks"].get(kind)
    return "%d из %d" % (c[0], c[1]) if c else "—"


for res in rows:
    done = res["n"] - res["errors"]
    med = round(statistics.median(res["secs"]), 1) if res["secs"] else "—"
    lines.append("| %s | %d | %d из %d | %s | %s | %s | %s | %s | %s | %s |" % (res["name"], res["n"], done, res["n"], cell(res, "fix"), cell(res, "shorten"), cell(res, "insight"), cell(res, "custom"), cell(res, "structure"), cell(res, "apply+undo"), med))
lines += ["", "## По заданиям", ""]
for res in rows:
    lines += ["### " + res["name"], "", "| № | Задание | Итог | Подробности | с |", "|---|---|---|---|---|"]
    for id_, label, verdict, note, secs in res["details"]:
        lines.append("| %s | %s | %s | %s | %s |" % (id_, label[:50].replace("|", "/"), "верно" if verdict else "НЕВЕРНО", note.replace("|", "/"), secs))
    lines.append("")
out_path.write_text("\n".join(lines), encoding="utf-8")
print("written", out_path)
