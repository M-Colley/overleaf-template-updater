"""Inspect the official ACM acmart template zip.

Kept in the repo because the ACM zip is the only published source of a *built*
acmart.cls, and its internal layout is what registry/templates.json depends on.
Run it if ACM reorganise the archive.

    python test/inspect_acm_zip.py <path-to-acmart-primary.zip>
"""
import re
import sys
import zipfile

BS = chr(92)  # avoid literal backslashes in patterns for shell-safety
PROVIDES = re.compile(BS + BS + r"ProvidesClass\s*\{([^}]*)\}\s*\[([^\]]*)\]", re.S)


def main(path: str) -> None:
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    print(f"{len(infos)} entries, "
          f"{sum(i.file_size for i in infos) / 1e6:.1f} MB uncompressed\n")

    cls_name = next(n for n in z.namelist() if n.endswith("/acmart.cls"))
    cls = z.read(cls_name).decode("utf8", "replace")
    m = PROVIDES.search(cls)
    print(f"{cls_name}")
    print(f"  ProvidesClass -> {m.group(1)}  [{' '.join(m.group(2).split())[:64]}]")

    bst_name = next(n for n in z.namelist() if n.endswith("ACM-Reference-Format.bst"))
    bst = z.read(bst_name).decode("utf8", "replace")
    print(f"\n{bst_name}")
    print(f"  version        -> {re.search(r'[ ]version[ ]*=[ ]*.([^.]+).', bst).group(1)}")
    print(f"  acmart-version -> {re.search(r'acmart-version[ ]*=[ ]*.([^.]+).', bst).group(1)}")

    print("\nother updatable assets:")
    for i in infos:
        if i.filename.endswith((".bbx", ".cbx", ".dbx", ".sty")):
            print(f"  {i.file_size:>8,}  {i.filename.split('/')[-1]}")

    samples = [n.split("/")[-1] for n in z.namelist()
               if "/samples/" in n and n.endswith(".tex")]
    print(f"\nsamples/ ({len(samples)} .tex):")
    for s in sorted(samples):
        print(f"  {s}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "acmart-primary.zip")
