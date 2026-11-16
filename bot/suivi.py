"""Suivre un backtest en direct : python -m bot.suivi --days 30

Affiche toutes les 3 secondes combien de messages Claude a déjà lus, puis le résumé quand c'est fini.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

OUT = Path("data/backtest")


def key(*parts) -> str:  # même calcul que CachedAI._key
    return "p:" + hashlib.sha1(json.dumps(parts, ensure_ascii=False, default=str).encode()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    args = ap.parse_args()
    log = Path(f"data/backtest_{args.days}j.log")
    msg_file = OUT / f"messages_{args.days}j.json"
    start = time.time()

    while True:
        os.system("cls" if os.name == "nt" else "clear")
        print(f"=== Backtest {args.days} jours : suivi en direct (Ctrl+C pour quitter cette fenêtre) ===\n")
        lines = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        done = any(l.startswith("exit ") for l in lines)

        if msg_file.exists():
            try:
                msgs = json.loads(msg_file.read_text(encoding="utf-8"))
                cache = json.loads((OUT / "cache_ia.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                time.sleep(1)  # fichier en cours d'écriture
                continue
            by_id = {m["id"]: m["text"] for m in msgs}
            read = sum(1 for m in msgs if key(m["text"], by_id.get(m["reply_to"])) in cache)
            total = len(msgs)
            pct = 100 * read / total if total else 100
            bar = "█" * int(pct / 2.5) + "░" * (40 - int(pct / 2.5))
            print(f"Messages lus par Claude : {read} / {total}")
            print(f"[{bar}] {pct:.0f} %\n")
        else:
            print("Téléchargement des messages et des prix…\n")

        if done:
            text = "\n".join(lines)
            print(text.split("## Pourquoi")[0].split("Rejeu en cours")[-1].strip() if "## Résumé" in text else text)
            graph = [l for l in lines if l.startswith("Graphique")]
            if graph:
                print("\n" + graph[0])
            print("\n✅ Terminé. Tu peux fermer cette fenêtre.")
            break
        print(f"En cours depuis {int(time.time() - start)} s…")
        time.sleep(3)


if __name__ == "__main__":
    main()
