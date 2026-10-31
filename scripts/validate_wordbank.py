#!/usr/bin/env python3
import json
import re
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "data" / "wordbank.json"
data = json.loads(path.read_text(encoding="utf-8"))
words = []
for topic in data["topics"]:
    assert topic["wordCount"] == len(topic["words"]), topic["name"]
    assert 1 <= len(topic["words"]) <= 200, topic["name"]
    for word in topic["words"]:
        assert re.fullmatch(r"[a-z]+", word), (topic["name"], word)
        words.append(word.casefold())
assert data["wordCount"] == len(words), (data["wordCount"], len(words))
assert data["topicCount"] == len(data["topics"]), data["topicCount"]
assert len(words) == 2000, len(words)
assert len(set(words)) == len(words), "Duplicate word found"
print(f"OK: {len(words)} unique words across {len(data['topics'])} topics")
