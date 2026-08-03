#!/usr/bin/env python3
"""Build data/admech.json from a local clone of the BSData wh40k-11e catalogues.

Usage:
    git clone --depth 1 https://github.com/BSData/wh40k-11e.git
    python3 tools/build_data.py wh40k-11e

The only source of truth is that repository. Nothing is hand-edited or pulled
from anywhere else. Legends and Crucible datasheets are excluded, as are
Enhancements, Crusade content and optional weapon modifications, which are not
part of a datasheet's printed statlines.
"""
import json
import os
import re
import subprocess
import sys
from datetime import date

GAME_SYSTEM = "Warhammer 40,000.json"
CATALOGUE = "Imperium - Adeptus Mechanicus.json"

# profileType ids, defined in the game system file
UNIT = "c547-1836-d8a-ff4f"
RANGED = "f77d-b953-8fa4-b762"
MELEE = "8a40-4aaa-c780-9046"
ABILITY = "9cc3-6d83-4dd3-9b64"
TRANSPORT = "74f8-5443-9d6d-1f1e"

# entries whose names mark them as not part of a datasheet
EXCLUDED_ENTRIES = {"Crusade", "Enhancements", "Weapon Modifications"}
# top level entry links that are not units
NOT_A_UNIT = {"Detachment", "Show/Hide Options", "Order of Battle"}
EXCLUDED_UNITS = re.compile(r"\[(Legends|Crucible)\]")

UNIT_STATS = ["M", "T", "Sv", "W", "LD", "OC"]
RANGED_STATS = ["Range", "A", "BS", "S", "AP", "D"]
MELEE_STATS = ["Range", "A", "WS", "S", "AP", "D"]

# category links that describe the army rather than the datasheet
BORING_KEYWORDS = re.compile(r"^(Faction:|Configuration|Detachment)")


def load(src):
    """Index every node in the game system + catalogue by its BattleScribe id."""
    index = {}

    def walk(node):
        if isinstance(node, dict):
            node_id = node.get("id")
            if isinstance(node_id, str):
                index.setdefault(node_id, node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    roots = {}
    for filename in (GAME_SYSTEM, CATALOGUE):
        with open(os.path.join(src, filename), encoding="utf-8") as handle:
            doc = json.load(handle)
        root = doc.get("catalogue") or doc.get("gameSystem")
        roots[filename] = root
        walk(root)
    return index, roots


def clean(text):
    """Strip BattleScribe's ^^ keyword markers, keeping **bold** intact."""
    return re.sub(r"\^\^", "", text or "").strip()


def characteristics(profile):
    return {
        c["name"]: clean(c.get("$text"))
        for c in profile.get("characteristics", []) or []
    }


def collect_profiles(node, index, out, rules, seen, depth=0):
    """Walk a datasheet's entry tree, gathering every profile it can show."""
    if node is None or depth > 12 or id(node) in seen:
        return
    seen.add(id(node))

    for profile in node.get("profiles", []) or []:
        out.append(profile)
    for link in node.get("infoLinks", []) or []:
        if link.get("type") == "profile":
            target = index.get(link.get("targetId"))
            if target is not None:
                out.append(target)
        elif link.get("type") == "rule":
            rules.append(link)
    for key in ("selectionEntries", "selectionEntryGroups"):
        for child in node.get(key, []) or []:
            if child.get("name") in EXCLUDED_ENTRIES:
                continue
            collect_profiles(child, index, out, rules, seen, depth + 1)
    for link in node.get("entryLinks", []) or []:
        if link.get("name") in EXCLUDED_ENTRIES:
            continue
        collect_profiles(index.get(link.get("targetId")), index, out, rules, seen, depth + 1)


def feel_no_pain(rules):
    """Feel No Pain is a rule link whose value is appended onto its name."""
    for link in rules:
        if clean(link.get("name")) != "Feel No Pain":
            continue
        for modifier in link.get("modifiers", []) or []:
            if modifier.get("field") == "name" and modifier.get("type") == "append":
                return clean(modifier.get("value"))
    return ""


def row(names, values):
    return [values.get(name) or "-" for name in names]


def build_unit(name, entry, index):
    profiles, rules = [], []
    collect_profiles(entry, index, profiles, rules, set())

    models, ranged, melee, abilities, transport = [], [], [], [], []
    deduped = set()
    for profile in profiles:
        values = characteristics(profile)
        kind = profile.get("typeId")
        key = (kind, profile.get("name"), tuple(sorted(values.items())))
        if key in deduped:
            continue
        deduped.add(key)

        profile_name = clean(profile.get("name"))
        if kind == UNIT:
            models.append(
                {
                    "name": profile_name,
                    "stats": row(UNIT_STATS, values),
                    "inv": values.get("InSv", ""),
                }
            )
        elif kind == RANGED:
            ranged.append(
                {
                    "name": profile_name,
                    "stats": row(RANGED_STATS, values),
                    "kw": values.get("Keywords", "-"),
                }
            )
        elif kind == MELEE:
            melee.append(
                {
                    "name": profile_name,
                    "stats": row(MELEE_STATS, values),
                    "kw": values.get("Keywords", "-"),
                }
            )
        elif kind == ABILITY:
            abilities.append({"name": profile_name, "text": values.get("Description", "")})
        elif kind == TRANSPORT:
            transport.append(values.get("Capacity", ""))

    # Loadout variants often repeat one statline under different names
    # (e.g. Ironstrider Ballistarii). Collapse those into a single profile.
    by_stats = {}
    for model in models:
        by_stats.setdefault((tuple(model["stats"]), model["inv"]), []).append(model)
    if len(by_stats) == 1 and len(models) > 1:
        models = [{**models[0], "name": name}]

    links = entry.get("categoryLinks", []) or []
    role = next((clean(c["name"]) for c in links if c.get("primary")), "")
    keywords = [
        clean(c["name"])
        for c in links
        if not c.get("primary") and not BORING_KEYWORDS.match(c["name"])
    ]

    return {
        "name": name,
        "role": role,
        "fnp": feel_no_pain(rules),
        "keywords": keywords,
        "models": models,
        "ranged": ranged,
        "melee": melee,
        "abilities": abilities,
        "transport": transport,
    }


def keyword_rules(units, game_system):
    """Map every weapon keyword used by the faction to its rule text.

    A keyword on a weapon carries its parameter — "Sustained Hits 1",
    "Anti-Vehicle 4+" — while the rule is filed under the bare name.
    """
    rules = {}
    for rule in game_system.get("sharedRules", []) or []:
        rules[clean(rule["name"]).lower()] = rule

    def lookup(keyword):
        candidates = [keyword.lower()]
        # drop a trailing parameter: "1", "4+", "6\""
        candidates.append(re.sub(r'\s+\d+\+?"?$', "", keyword).lower())
        # "Anti-Vehicle 4+" is filed under "Anti"
        candidates.append(re.split(r"[-‑]", keyword)[0].strip().lower())
        for candidate in candidates:
            if candidate in rules:
                return rules[candidate]
        return None

    used, missing = {}, set()
    for unit in units:
        for weapon in unit["ranged"] + unit["melee"]:
            for keyword in split_keywords(weapon["kw"]):
                rule = lookup(keyword)
                if rule is None:
                    missing.add(keyword)
                    continue
                name = clean(rule["name"])
                used[name] = clean(rule.get("description"))

    for keyword in sorted(missing):
        print(f"warning: no rule found for keyword {keyword!r}", file=sys.stderr)
    return used


def split_keywords(keywords):
    if not keywords or keywords == "-":
        return []
    return [k.strip() for k in keywords.split(",") if k.strip()]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "wh40k-11e"
    index, roots = load(src)
    catalogue = roots[CATALOGUE]

    units = []
    for link in catalogue["entryLinks"]:
        name = clean(link["name"])
        if name in NOT_A_UNIT or EXCLUDED_UNITS.search(name):
            continue
        entry = index.get(link["targetId"])
        if entry is None:
            print(f"warning: unresolved entry link {name!r}", file=sys.stderr)
            continue
        unit = build_unit(name, entry, index)
        if not unit["models"]:
            print(f"warning: no unit profile for {name!r}, skipping", file=sys.stderr)
            continue
        units.append(unit)

    units.sort(key=lambda u: u["name"])

    try:
        commit = subprocess.check_output(
            ["git", "-C", src, "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        commit = "unknown"

    keywords = keyword_rules(units, roots[GAME_SYSTEM])

    data = {
        "faction": "Adeptus Mechanicus",
        "keywordRules": keywords,
        "source": {
            "repo": "BSData/wh40k-11e",
            "commit": commit,
            "catalogue": catalogue["name"],
            "revision": catalogue.get("revision"),
            "generated": date.today().isoformat(),
        },
        "units": units,
    }

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "data", "admech.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    weapons = sum(len(u["ranged"]) + len(u["melee"]) for u in units)
    print(f"{len(units)} units, {weapons} weapon profiles -> {out}")


if __name__ == "__main__":
    main()
