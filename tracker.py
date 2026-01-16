#!/usr/bin/env python3
"""Company-impact tracker for public statements and actions."""
from __future__ import annotations

import argparse
import datetime as dt
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

DEFAULT_DB = Path("tracker.db")


@dataclass(frozen=True)
class Event:
    event_date: str
    source: str
    subject: str
    company: str
    summary: str
    url: str
    sentiment: str
    tags: str


SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    source TEXT NOT NULL,
    subject TEXT NOT NULL,
    company TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(SCHEMA)


def insert_event(db_path: Path, event: Event) -> None:
    init_db(db_path)
    created_at = dt.datetime.utcnow().isoformat()
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO events (
                event_date, source, subject, company, summary, url, sentiment, tags, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.event_date,
                event.source,
                event.subject,
                event.company,
                event.summary,
                event.url,
                event.sentiment,
                event.tags,
                created_at,
            ),
        )


def fetch_events(db_path: Path, company: str | None) -> Iterable[sqlite3.Row]:
    init_db(db_path)
    with connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        if company:
            return conn.execute(
                """
                SELECT * FROM events
                WHERE company LIKE ?
                ORDER BY event_date DESC
                """,
                (f"%{company}%",),
            ).fetchall()
        return conn.execute(
            """
            SELECT * FROM events
            ORDER BY event_date DESC
            """
        ).fetchall()


def render_events(rows: Iterable[sqlite3.Row]) -> str:
    lines = []
    for row in rows:
        lines.append(
            " | ".join(
                [
                    row["event_date"],
                    row["company"],
                    row["source"],
                    row["subject"],
                    row["sentiment"],
                    row["summary"],
                    row["url"],
                ]
            )
        )
    return "\n".join(lines) if lines else "No events found."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Track public statements or actions that may affect specific companies. "
            "This tool is for research and record-keeping only and is not investment advice."
        )
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to sqlite database")

    subparsers = parser.add_subparsers(dest="command", required=True)

    add = subparsers.add_parser("add", help="Add a new event")
    add.add_argument("--date", required=True, help="Event date in YYYY-MM-DD format")
    add.add_argument("--source", required=True, help="Source platform (e.g., Truth Social)")
    add.add_argument("--subject", required=True, help="Person or agency involved")
    add.add_argument("--company", required=True, help="Company name")
    add.add_argument("--summary", required=True, help="Short description of the event")
    add.add_argument("--url", required=True, help="Link to the source")
    add.add_argument(
        "--sentiment",
        required=True,
        choices=["positive", "neutral", "negative", "mixed", "unknown"],
        help="Basic sentiment label",
    )
    add.add_argument("--tags", default="", help="Comma-separated tags")

    list_cmd = subparsers.add_parser("list", help="List events")
    list_cmd.add_argument("--company", help="Filter by company name")

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "add":
        event = Event(
            event_date=args.date,
            source=args.source,
            subject=args.subject,
            company=args.company,
            summary=args.summary,
            url=args.url,
            sentiment=args.sentiment,
            tags=args.tags,
        )
        insert_event(args.db, event)
        print("Event added.")
        return

    if args.command == "list":
        rows = fetch_events(args.db, args.company)
        print(render_events(rows))
        return

    raise SystemExit("Unknown command")


if __name__ == "__main__":
    main()
