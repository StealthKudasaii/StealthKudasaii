"""Mémoire du bot (SQLite) : messages lus, signaux pris, état de chaque trade."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .models import Side, Signal

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    chat_id INTEGER, msg_id INTEGER, text TEXT, parsed TEXT, created TEXT,
    PRIMARY KEY (chat_id, msg_id)
);
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id INTEGER, side TEXT, entry_low REAL, entry_high REAL, sl REAL, tps TEXT,
    status TEXT, tps_reached INTEGER DEFAULT 0, legs INTEGER DEFAULT 0,
    entry REAL, plan TEXT, verdict TEXT, created TEXT, server_time TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER, kind TEXT, detail TEXT, created TEXT
);
"""

# Statuts : open (positions/ordres en cours), closed, rejected, failed


class Store:
    def __init__(self, path: str | Path = "data/bot.sqlite"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def _now(self) -> str:
        return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")

    # -- messages ------------------------------------------------------------
    def save_message(self, chat_id: int, msg_id: int, text: str, parsed: Optional[dict]) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?)",
            (chat_id, msg_id, text, json.dumps(parsed, ensure_ascii=False) if parsed else None, self._now()),
        )
        self.db.commit()

    def message_text(self, chat_id: int, msg_id: int) -> Optional[str]:
        row = self.db.execute("SELECT text FROM messages WHERE chat_id=? AND msg_id=?", (chat_id, msg_id)).fetchone()
        return row["text"] if row else None

    # -- signaux -------------------------------------------------------------
    def add_signal(self, s: Signal, status: str, server_time: datetime, entry: float = 0.0,
                   plan: Optional[dict] = None, verdict: Optional[dict] = None, legs: int = 0) -> int:
        cur = self.db.execute(
            "INSERT INTO signals (msg_id, side, entry_low, entry_high, sl, tps, status, legs, entry, plan, verdict,"
            " created, server_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (s.source_msg_id, s.side.value, s.entry_low, s.entry_high, s.stop_loss, json.dumps(s.take_profits),
             status, legs, entry, json.dumps(plan, ensure_ascii=False) if plan else None,
             json.dumps(verdict, ensure_ascii=False) if verdict else None, self._now(),
             server_time.isoformat(timespec="seconds")),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def update_signal(self, sid: int, **fields) -> None:
        if "tps" in fields:
            fields["tps"] = json.dumps(fields["tps"])
        cols = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE signals SET {cols} WHERE id=?", (*fields.values(), sid))
        self.db.commit()

    def open_signals(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM signals WHERE status='open' ORDER BY id").fetchall()

    def signal_by_msg(self, msg_id: int) -> Optional[sqlite3.Row]:
        return self.db.execute("SELECT * FROM signals WHERE msg_id=? ORDER BY id DESC", (msg_id,)).fetchone()

    def executed_since(self, server_day_start: datetime) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM signals WHERE status IN ('open','closed') AND server_time >= ?",
            (server_day_start.isoformat(timespec="seconds"),),
        ).fetchall()

    def log(self, signal_id: Optional[int], kind: str, detail: str) -> None:
        self.db.execute("INSERT INTO events (signal_id, kind, detail, created) VALUES (?,?,?,?)",
                        (signal_id, kind, detail, self._now()))
        self.db.commit()


def row_side(row: sqlite3.Row) -> Side:
    return Side(row["side"])


def row_tps(row: sqlite3.Row) -> list[float]:
    return json.loads(row["tps"] or "[]")
