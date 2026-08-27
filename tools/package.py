"""Build a Chrome Web Store upload package.

Validates the manifest first, because the Web Store rejects a bad package only
after you have waited in the review queue.

    python tools/package.py            # -> dist/overleaf-template-updater-0.1.0.zip
    python tools/package.py --check    # validate only, write nothing
"""
import io
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")

# Anything that must never ship to users.
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDE_EXTS = {".map", ".log", ".bak"}


def load_manifest():
    with io.open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as fh:
        return json.load(fh)


def referenced_files(m):
    """Every path the manifest points at, so a missing one is caught here."""
    out = []
    bg = m.get("background", {})
    if bg.get("service_worker"):
        out.append(bg["service_worker"])
    for cs in m.get("content_scripts", []):
        out += cs.get("js", []) + cs.get("css", [])
    if m.get("options_page"):
        out.append(m["options_page"])
    if m.get("action", {}).get("default_popup"):
        out.append(m["action"]["default_popup"])
    out += list(m.get("icons", {}).values())
    out += list(m.get("action", {}).get("default_icon", {}).values())
    for war in m.get("web_accessible_resources", []):
        out += war.get("resources", [])
    return out


def validate(m):
    problems = []

    if m.get("manifest_version") != 3:
        problems.append("manifest_version must be 3")
    for field in ("name", "version", "description"):
        if not m.get(field):
            problems.append(f"missing required field: {field}")

    # Web Store limits.
    if len(m.get("name", "")) > 75:
        problems.append(f"name is {len(m['name'])} chars (max 75)")
    if len(m.get("description", "")) > 132:
        problems.append(
            f"description is {len(m['description'])} chars (max 132) - "
            "this is the store's short description and IS enforced"
        )

    for f in referenced_files(m):
        if not os.path.exists(os.path.join(EXT, f)):
            problems.append(f"manifest references a missing file: {f}")

    for size in ("16", "48", "128"):
        if size not in m.get("icons", {}):
            problems.append(f"missing {size}x{size} icon")

    # importScripts targets are not in the manifest, so check them explicitly.
    sw = m.get("background", {}).get("service_worker")
    if sw:
        with io.open(os.path.join(EXT, sw), encoding="utf-8") as fh:
            head = fh.read(4000)
        import re
        for call in re.findall(r"importScripts\(([^)]*)\)", head):
            for path in re.findall(r"['\"]([^'\"]+)['\"]", call):
                if not os.path.exists(os.path.join(EXT, path)):
                    problems.append(f"importScripts references a missing file: {path}")

    return problems


def collect():
    files = []
    for dirpath, dirnames, filenames in os.walk(EXT):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name in EXCLUDE_NAMES or os.path.splitext(name)[1] in EXCLUDE_EXTS:
                continue
            if name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            files.append((full, os.path.relpath(full, EXT).replace(os.sep, "/")))
    return sorted(files, key=lambda p: p[1])


def main():
    m = load_manifest()
    problems = validate(m)

    print(f"{m.get('name')}  v{m.get('version')}")
    print(f"  short description: {len(m.get('description',''))}/132 chars")
    print(f"  permissions:       {', '.join(m.get('permissions', []))}")
    print(f"  host permissions:  {len(m.get('host_permissions', []))}")
    if m.get("optional_host_permissions"):
        print(f"  optional hosts:    {', '.join(m['optional_host_permissions'])}")

    if problems:
        print("\nFAILED validation:")
        for p in problems:
            print("  - " + p)
        return 1
    print("  validation:        OK")

    if "--check" in sys.argv:
        return 0

    files = collect()
    os.makedirs(DIST, exist_ok=True)
    slug = m["name"].lower().replace(" ", "-")
    out = os.path.join(DIST, f"{slug}-{m['version']}.zip")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in files:
            z.write(full, rel)

    size = os.path.getsize(out)
    print(f"\nWrote {os.path.relpath(out, ROOT)}")
    print(f"  {len(files)} files, {size/1024:.0f} KB")
    for _, rel in files:
        print(f"    {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
