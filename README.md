# Imposter — V1 Word Bank Package

This package contains the first curated word bank for the Imposter party game.

## Contents

- `data/wordbank.json` — recommended runtime format, grouped by topic.
- `data/wordbank.csv` — flat spreadsheet-friendly export, one word per row.
- `data/wordbank.txt` — readable topic-by-topic list.
- `docs/topics.md` — topic descriptions and sample words.
- `scripts/validate_wordbank.py` — validation script for counts and duplicates.
- `manifest.json` — package metadata.

## Dataset summary

- **2,000 unique words**
- **21 selectable topics**
- English (`en`)
- One word per entry; no repeated word appears in another topic.
- Topics contain 95 or 96 words each.

## Topic selection

The lobby can show the topic names from `topics`. Players should be able to select one or more topics before the host starts the game. The game server should choose a secret word from the union of the selected topics.

## Cloudflare implementation note

Keep secret-word selection on the server (for example, inside the room's Durable Object). Do not send the complete unrevealed word bank or the selected secret word to every browser. Send each player only the role-specific reveal they are allowed to see.

## Validation

Run:

```bash
python scripts/validate_wordbank.py
```

The validator checks the total word count, per-topic counts, valid word format, and case-insensitive uniqueness.

## Versioning

This is the initial V1 word-bank dataset (`1.0.0`). The list can be expanded or edited later without changing the game architecture.
