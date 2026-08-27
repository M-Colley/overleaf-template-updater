"""Compare the front-matter shapes of the venue templates.

Used to design the template-migration mapping: what a paper must declare under
acmart versus IEEEtran, and therefore what a converter has to rewrite, scaffold,
or hand back to the author.

    python test/inspect_venue_shapes.py <acmart-primary.zip> [IEEEtran.cls]
"""
import re
import sys
import zipfile

BS = chr(92)


def rx(body: str) -> "re.Pattern":
    """Build a regex where BS stands in for a literal backslash."""
    return re.compile(body.replace("@", BS + BS))


ACM_VENUE = rx(r"^\s*@(setcopyright|copyrightyear|acmYear|acmDOI|acmConference"
               r"|acmISBN|acmBooktitle|acmPrice|acmJournal)")
ACM_META = rx(r"^\s*@(title|author|email|orcid|affiliation|institution|city"
              r"|state|country|keywords|ccsdesc|renewcommand\{@shortauthors)")
ACM_STRUCT = rx(r"^\s*(@begin\{abstract\}|@maketitle|@begin\{CCSXML\}"
                r"|@begin\{teaserfigure\}|@received|@bibliographystyle|@bibliography)")


def show(title, lines, pattern, limit=40):
    print(f"\n=== {title} ===")
    hits = [l.strip() for l in lines if pattern.match(l)]
    for h in hits[:limit]:
        print("  " + h[:96])
    if not hits:
        print("  (none)")


def acmart(path):
    z = zipfile.ZipFile(path)
    name = next(n for n in z.namelist() if n.endswith("samples/sigconf.tex"))
    lines = z.read(name).decode("utf8", "replace").split("\n")
    print(f"### acmart / sigconf  ({name})")
    show("venue + copyright (all required for a real submission)", lines, ACM_VENUE)
    show("author + metadata", lines, ACM_META, limit=24)
    show("structure", lines, ACM_STRUCT)


def ieeetran(path):
    """IEEEtran's own documentation of its author-block commands."""
    with open(path, encoding="utf8", errors="replace") as fh:
        text = fh.read()
    print("\n\n### IEEEtran")
    cmds = sorted(set(re.findall(BS + BS + r"def(" + BS + BS + r"IEEE[A-Za-z@]+)", text)))
    author = [c for c in cmds if "author" in c.lower() or "pubid" in c.lower()
              or "PARstart" in c or "keywords" in c.lower()]
    print("\n=== IEEEtran front-matter commands a paper typically uses ===")
    for c in author[:20]:
        print("  " + c)
    print(f"\n  ({len(cmds)} IEEE* internal commands defined in total)")


if __name__ == "__main__":
    acmart(sys.argv[1] if len(sys.argv) > 1 else "acmart-primary.zip")
    if len(sys.argv) > 2:
        ieeetran(sys.argv[2])
