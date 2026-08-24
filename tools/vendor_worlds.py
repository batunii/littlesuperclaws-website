#!/usr/bin/env python3
"""Download the pregenerated Marble worlds into worlds/ so the public site
needs no API key at all.

Marble's asset URLs are signed and expire, so the live site normally re-fetches
them per view — which requires the key. This script fetches each world once,
saves the assets locally, and writes js/worlds-local.js. After that the site
resolves those worlds entirely from same-origin static files.

Run once, locally, with the key in the environment:

    WORLDLABS_API_KEY=... python tools/vendor_worlds.py
    infisical run -- python tools/vendor_worlds.py      # if you use Infisical

Options:
    --tiers 100k,500k   splat resolutions to fetch (default: both)
                        100k = mobile, 500k = desktop; see pickSplatUrl()
    --slugs a,b         only these manifest slugs (default: all)
    --force             re-download files that already exist
"""
import json, os, re, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.worldlabs.ai/marble/v1"
MANIFEST_JS = os.path.join(ROOT, "js", "worlds-manifest.js")
OUT_JS = os.path.join(ROOT, "js", "worlds-local.js")
WORLDS_DIR = os.path.join(ROOT, "worlds")

KEY = os.environ.get("WORLDLABS_API_KEY")
if not KEY:
    sys.exit("WORLDLABS_API_KEY is not set.\n"
             "  WORLDLABS_API_KEY=... python tools/vendor_worlds.py")


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


TIERS = [t.strip() for t in arg("--tiers", "100k,500k").split(",") if t.strip()]
ONLY = [s.strip() for s in (arg("--slugs") or "").split(",") if s.strip()]
FORCE = "--force" in sys.argv


def read_manifest():
    """js/worlds-manifest.js is `window.LSC_WORLDS = {...};` — pull the JSON."""
    src = open(MANIFEST_JS, encoding="utf-8").read()
    m = re.search(r"window\.LSC_WORLDS\s*=\s*(\{.*\})\s*;", src, re.S)
    if not m:
        sys.exit(f"Could not parse {MANIFEST_JS}")
    return json.loads(m.group(1))


def api(path):
    req = urllib.request.Request(
        API + path,
        headers={"WLT-Api-Key": KEY, "Content-Type": "application/json"},
        method="GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def ext_of(url, fallback):
    path = url.split("?", 1)[0]
    e = os.path.splitext(path)[1]
    return e if 1 < len(e) <= 6 else fallback


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.0f}{u}" if u == "B" else f"{n/1:.1f}{u}"
        n /= 1024
    return f"{n:.1f}GB"


def download(url, dest):
    """Stream to a .part file, then rename — so an interrupted run resumes."""
    if os.path.exists(dest) and not FORCE:
        return os.path.getsize(dest), True
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 // total
                print(f"\r      {pct:3d}%  {human(got)}/{human(total)}", end="", flush=True)
    os.replace(tmp, dest)
    if total:
        print("\r" + " " * 40 + "\r", end="")
    return os.path.getsize(dest), False


def main():
    manifest = read_manifest()
    slugs = [s for s in manifest if not ONLY or s in ONLY]
    if not slugs:
        sys.exit("No matching slugs.")

    print(f"Vendoring {len(slugs)} world(s), splat tiers: {', '.join(TIERS)}\n")
    local, sizes, failures = {}, {}, []

    for slug in slugs:
        entry = manifest[slug]
        wid = entry["worldId"]
        print(f"  {entry.get('name', slug)}  ({slug})")
        try:
            world = api(f"/worlds/{wid}")
        except urllib.error.HTTPError as e:
            print(f"      ! world fetch failed: {e.code} {e.reason}")
            failures.append(slug)
            continue

        assets = world.get("assets") or {}
        spz = ((assets.get("splats") or {}).get("spz_urls")) or {}
        mesh = (assets.get("mesh") or {}).get("collider_mesh_url")
        pano = (assets.get("imagery") or {}).get("pano_url")
        thumb = assets.get("thumbnail_url")

        rec, total = {"spz_urls": {}}, 0
        wanted = [(f"splat-{t}", spz.get(t), ".spz", ("spz", t)) for t in TIERS]
        wanted += [("pano", pano, ".jpg", ("pano_url", None)),
                   ("collider", mesh, ".glb", ("collider_mesh_url", None)),
                   ("thumb", thumb, ".jpg", ("thumbnail_url", None))]

        for stem, url, fb, (kind, tier) in wanted:
            if not url:
                if kind == "spz":
                    print(f"      - {tier} tier not offered by this world, skipping")
                continue
            name = stem + ext_of(url, fb)
            dest = os.path.join(WORLDS_DIR, slug, name)
            try:
                size, cached = download(url, dest)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
                print(f"      ! {name} failed: {e}")
                failures.append(f"{slug}/{name}")
                continue
            total += size
            rel = f"worlds/{slug}/{name}"
            if kind == "spz":
                rec["spz_urls"][tier] = rel
            else:
                rec[kind] = rel
            print(f"      {'·' if cached else '+'} {name:20s} {human(size):>9s}"
                  f"{'  (already had it)' if cached else ''}")

        if not rec["spz_urls"]:
            print("      ! no splat downloaded — skipping this world")
            failures.append(slug)
            continue
        local[slug] = rec
        sizes[slug] = total
        print(f"      = {human(total)}\n")

    if not local:
        sys.exit("Nothing vendored.")

    banner = ("/* Auto-generated by tools/vendor_worlds.py — do not edit.\n"
              "   Locally vendored Marble assets. Their presence is what lets the\n"
              "   public site serve these worlds with no API key: worldlabs.js\n"
              "   returns a synthetic world object instead of calling the API. */\n")
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(banner)
        f.write("window.LSC_WORLDS_LOCAL = ")
        json.dump(local, f, indent=2, ensure_ascii=False)
        f.write(";\n")

    grand = sum(sizes.values())
    print("-" * 52)
    for slug, n in sorted(sizes.items(), key=lambda kv: -kv[1]):
        print(f"  {slug:22s} {human(n):>10s}")
    print(f"  {'TOTAL':22s} {human(grand):>10s}")
    print(f"\nWrote {os.path.relpath(OUT_JS, ROOT)} ({len(local)} worlds).")
    if failures:
        print(f"Failed: {', '.join(failures)}")
    if grand > 500 * 1024 ** 2:
        print(f"\n!! {human(grand)} is a lot for GitHub Pages. The site is capped at\n"
              f"   1 GB and soft-limited to 100 GB/month of bandwidth. Consider\n"
              f"   --tiers 100k, or serving worlds/ from a CDN instead.")
    print("\nNext: reload the site — no key or proxy needed for these worlds.")


if __name__ == "__main__":
    main()
