#!/usr/bin/env python3
"""Pre-generate the site's fixed Dublin worlds on World Labs Marble.

Submits in waves (API allows ~3 concurrent generations), polls operations,
and writes:
  - tools/pregen-state.json   (live progress, resumable)
  - worlds-manifest.js        (window.LSC_WORLDS for the site)
Safe to re-run: already-completed slugs are skipped.
"""
import json, os, re, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.worldlabs.ai/marble/v1"
KEY = re.search(r"(\S+)\s*$", open(os.path.join(ROOT, "WorldLabsAPI.txt")).read()).group(1)
STATE_PATH = os.path.join(ROOT, "tools", "pregen-state.json")
MANIFEST_PATH = os.path.join(ROOT, "worlds-manifest.js")

LOCATIONS = [
    ("temple-bar", "Temple Bar", "Photorealistic street-level view of Temple Bar, Dublin, Ireland in the evening: cobblestone square, the famous bright red Temple Bar pub facade with hanging flower baskets, warm golden pub light spilling onto wet cobbles, string lights between Georgian brick buildings, moody Irish dusk sky."),
    ("grafton-street", "Grafton Street", "Photorealistic street-level view of Grafton Street, Dublin, Ireland: pedestrianised shopping street with red brick paving, Victorian shopfronts, Brown Thomas facade, flower sellers' stalls with colourful blooms, warm afternoon light, overcast Irish sky."),
    ("lighthouse-cinema", "Lighthouse Cinema", "Photorealistic view of the Light House Cinema in Smithfield Square, Dublin, Ireland at dusk: modern glass cinema facade glowing warmly, tall gaslight-style masts of Smithfield Plaza, cobbled square, apartment buildings, cool blue evening light."),
    ("croke-park", "Croke Park", "Photorealistic view from inside Croke Park stadium, Dublin, Ireland: vast green GAA pitch, towering stands with blue seats, Hill 16, floodlights on under a dramatic grey Irish sky, stadium scale and atmosphere."),
    ("stephens-green", "St Stephen's Green", "Photorealistic view inside St Stephen's Green park, Dublin, Ireland: ornamental lake with ducks, stone bridge, Victorian bandstand, manicured flowerbeds in bloom, mature trees, soft morning sunlight through leaves."),
    ("hapenny-bridge", "Ha'penny Bridge", "Photorealistic view standing on the Ha'penny Bridge, Dublin, Ireland at golden hour: white cast-iron pedestrian arch bridge over the River Liffey, ornate lamps glowing, Liffey boardwalk and Georgian quay buildings reflected in the river, warm low sun."),
    ("the-spire", "The Spire", "Photorealistic street-level view of the Spire of Dublin on O'Connell Street, Ireland: gleaming 120m stainless steel needle monument rising into an overcast sky, wide boulevard with Luas tram tracks, the GPO's granite columns, buses and city bustle."),
    ("liffey-quays", "Liffey Quays", "Photorealistic view along the River Liffey quays in Dublin, Ireland at blue hour: the river flowing between stone quay walls, rows of lit Georgian buildings on both banks, multiple bridges receding into the distance, street lamps and window lights reflecting in the water."),
]

# Aliases let the site resolve free-typed searches to pregenerated worlds.
ALIASES = {
    "temple-bar": ["temple bar"],
    "grafton-street": ["grafton street", "grafton"],
    "lighthouse-cinema": ["lighthouse cinema", "light house cinema", "smithfield"],
    "croke-park": ["croke park", "croker"],
    "stephens-green": ["st stephen's green", "stephens green", "st stephens green", "stephen's green"],
    "hapenny-bridge": ["ha'penny bridge", "hapenny bridge", "halfpenny bridge"],
    "the-spire": ["the spire", "spire", "o'connell street", "oconnell street"],
    "liffey-quays": ["liffey quays", "river liffey", "liffey", "the quays"],
}

def api(path, body=None):
    req = urllib.request.Request(API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"WLT-Api-Key": KEY, "Content-Type": "application/json"},
        method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def load_state():
    # Seed from the earlier pregen.ps1 run if present.
    state = {}
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH, encoding="utf-8-sig"))
    elif os.path.exists(os.path.join(ROOT, "tools", "pregen-ops.json")):
        for e in json.load(open(os.path.join(ROOT, "tools", "pregen-ops.json"), encoding="utf-8-sig")):
            if e.get("operation_id"):
                state[e["slug"]] = {"name": e["name"], "operation_id": e["operation_id"],
                                    "world_id": e.get("world_id"), "status": "generating"}
    return state

def save_state(state):
    json.dump(state, open(STATE_PATH, "w", encoding="utf-8"), indent=2)

def write_manifest(state):
    worlds = {}
    for slug, name, _ in LOCATIONS:
        e = state.get(slug)
        if e and e.get("status") == "done":
            worlds[slug] = {"name": name, "worldId": e["world_id"],
                            "aliases": ALIASES.get(slug, [name.lower()])}
    js = ("// Auto-generated by tools/pregen.py - pregenerated Marble world IDs.\n"
          "// Signed asset URLs expire, so the site fetches fresh ones per world ID at runtime.\n"
          "window.LSC_WORLDS = " + json.dumps(worlds, indent=2) + ";\n"
          "window.LSC_EXPLORE_WORLD = " + json.dumps(worlds.get("liffey-quays", {}).get("worldId")) + ";\n")
    open(MANIFEST_PATH, "w", encoding="utf-8").write(js)

def main():
    state = load_state()
    deadline = time.time() + 50 * 60
    while time.time() < deadline:
        pending_submit = [l for l in LOCATIONS if state.get(l[0], {}).get("status") not in ("generating", "done")]
        generating = [s for s, e in state.items() if e.get("status") == "generating"]

        # poll generating ops
        for slug in generating:
            e = state[slug]
            try:
                op = api(f"/operations/{e['operation_id']}")
            except Exception as ex:
                print(f"[poll] {slug}: {ex}", flush=True); continue
            if op.get("done"):
                result = op.get("response") or op.get("result") or {}
                wid = result.get("id") or (op.get("metadata") or {}).get("world_id") or e.get("world_id")
                err = op.get("error")
                if err:
                    e["status"] = "failed"; e["error"] = str(err)
                    print(f"[done-ERR] {slug}: {err}", flush=True)
                else:
                    e["status"] = "done"; e["world_id"] = wid
                    print(f"[done] {slug} world={wid}", flush=True)
            else:
                desc = ((op.get("metadata") or {}).get("progress") or {}).get("status", "?")
                print(f"[gen] {slug}: {desc}", flush=True)

        # submit more if there is room (3 concurrent observed)
        slots = 3 - sum(1 for e in state.values() if e.get("status") == "generating")
        for slug, name, prompt in pending_submit[:max(0, slots)]:
            try:
                r = api("/worlds:generate", {"display_name": f"LSC - {name}", "model": "marble-1.1",
                                             "world_prompt": {"type": "text", "text_prompt": prompt}})
                state[slug] = {"name": name, "operation_id": r["operation_id"],
                               "world_id": (r.get("metadata") or {}).get("world_id"), "status": "generating"}
                print(f"[submit] {slug} op={r['operation_id']}", flush=True)
            except urllib.error.HTTPError as ex:
                msg = ex.read().decode()[:200]
                if ex.code != 429:
                    state[slug] = {"name": name, "status": "failed", "error": msg}
                print(f"[submit-fail {ex.code}] {slug}: {msg}", flush=True)

        save_state(state)
        write_manifest(state)
        if all(state.get(s, {}).get("status") in ("done", "failed") for s, _, _ in LOCATIONS):
            break
        time.sleep(25)

    done = sum(1 for e in state.values() if e.get("status") == "done")
    print(f"FINISHED: {done}/{len(LOCATIONS)} worlds done", flush=True)
    for slug, e in state.items():
        print(f"  {slug}: {e.get('status')} {e.get('world_id') or e.get('error','')}", flush=True)

if __name__ == "__main__":
    main()
