"""python -m bot.list_chats : affiche tes groupes/canaux Telegram avec leur ID, pour remplir config.yaml."""
from __future__ import annotations

import asyncio
from pathlib import Path

from .config import env


async def main() -> None:
    from dotenv import load_dotenv
    from telethon import TelegramClient

    load_dotenv()
    Path("data").mkdir(exist_ok=True)
    async with TelegramClient("data/telegram", int(env("TELEGRAM_API_ID")), env("TELEGRAM_API_HASH")) as client:
        async for d in client.iter_dialogs():
            if d.is_group or d.is_channel:
                print(f"{d.id:>16}  {d.name}")


if __name__ == "__main__":
    asyncio.run(main())
