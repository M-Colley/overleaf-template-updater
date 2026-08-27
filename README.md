# Template Updater for Overleaf

**Overleaf copies a template into your project once, at creation, and never looks
back.**

When ACM ships a new `acmart`, your CHI submission is still sitting on whatever
version it was forked from — quietly, with no indication anything has changed.
There is no "update template" button, because from Overleaf's point of view your
project isn't a copy of anything. It's just files.

This repo adds one. Two, actually, for different situations.

|  | [Chrome extension](#the-chrome-extension) | [`otu` CLI](#the-otu-cli) |
|---|---|---|
| **Works on** | any Overleaf account | needs Overleaf **git access** (paid) |
| **Updates** | template machinery (`.cls`, `.sty`, `.bst`, `.bbx`) | any file, including `main.tex` |
| **Merge model** | file replacement | real **three-way merge** |
| **Your prose** | never touched | merged, conflicts flagged |
| **Setup** | load unpacked, click a button | one `otu init` per project |

Use the extension for the common case — *"is my class file stale?"* Use the CLI
when you also want the template's **boilerplate** changes — new preamble macros,
a rewritten conference block — merged into a `main.tex` you have already written
a paper into.

---

## The Chrome extension

### Install

```bash
git clone https://github.com/M-Colley/overleaf-template-updater.git
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `extension/` folder.

Open an Overleaf project. A **⟳ Template** button appears bottom-right.

> If a project tab was already open, reload it — content scripts only inject on
> page load. Clicking the extension's toolbar icon tells you exactly what it sees
> on the current tab and offers the fix.

### What it does

Clicking the button runs a **read-only** scan:

1. Downloads the project once (`GET /project/:id/download/zip`) and unpacks it in
   the browser.
2. Identifies the template from `\documentclass{…}` and any bundled `.cls`.
3. Reads each file's version from its `\ProvidesClass` / `\ProvidesFile` header —
   or, for `.bst`, its `%%% version = "…"` block.
4. Looks up the current upstream release and compares.
5. Shows a per-file verdict and a **line-by-line diff of exactly what would
   change**.

Nothing is written until you tick files and press **Apply**.

### What it will and won't touch

It only ever writes **`.cls`, `.sty`, `.bst`, `.bbx`, `.cbx`, `.dbx`** — template
machinery.

**It never rewrites a `.tex` file.** That's where your paper lives, and no
version heuristic is worth the risk. Drift in your own preamble is *reported*,
never silently "fixed". If you want that merged, that's what the CLI is for.

### Safety

- The scan is read-only; nothing changes until you press Apply.
- A `.zip` backup of the project downloads first (toggleable).
- Every change lands in **Overleaf's own History panel**, so it's revertible from
  Overleaf itself.
- Deletions always ask for explicit confirmation.
- Downloaded class files are **verified before use** — see
  [mirrors are not trustworthy](#mirrors-are-not-trustworthy).

### Which Overleaf hosts are covered

Overleaf isn't only `www.overleaf.com`. It serves regional hosts like
`de.overleaf.com`, and universities frequently run **Overleaf Server Pro** on
their own domain.

Covered out of the box: `www.overleaf.com`, bare `overleaf.com`, and any
`*.overleaf.com` subdomain.

For a self-hosted instance on an unrelated domain, open the toolbar popup on that
site and click **Enable on `<host>`**. That uses an *optional* permission, so you
grant one domain at a time rather than the extension demanding access to every
site up front. Everything it does is origin-relative — including the backup
download, which follows the tab you're actually on.

### Tracked templates

| Template | Files | Handling | Source |
|---|---|---|---|
| **acmart**<br><sub>CHI, CSCW, UIST, AutomotiveUI, IMWUT, ACM journals</sub> | `acmart.cls`, `ACM-Reference-Format.bst`, `acm{authoryear,numeric}.{bbx,cbx}`, `acmdatamodel.dbx` | auto-update | ACM's official template archive |
| **IEEEtran** | `IEEEtran.cls`, `IEEEtran.bst` | auto-update | CTAN |
| **llncs** <sub>(Springer LNCS)</sub> | `llncs.cls`, `splncs04.bst` | auto-update | CTAN |
| **elsarticle** <sub>(Elsevier)</sub> | `elsarticle.cls` | report only | — |

<details>
<summary><b>Why acmart comes from a 15 MB ACM archive rather than CTAN</b></summary>

Because **there is no compiled `acmart.cls` published anywhere else.** Verified
against the live servers:

- `ctan.org/…/acmart/acmart.cls` → **HTTP 404**. CTAN carries `acmart.dtx` only.
- No `acmart.tds.zip` exists (the usual home for built files).
- `github.com/borisveytsman/acmart` has `.dtx`/`.ins` and **no release assets**.

The `.dtx` is a literate source that has to be run through `docstrip` and LaTeX
to produce a class — something a browser extension cannot do. ACM's own
[proceedings template archive](https://www.acm.org/publications/proceedings-template)
is the only place a built `acmart.cls` is published. It's downloaded once per
session, cached, and only if your project actually bundles a file from it.

`elsarticle` is report-only for the same reason in reverse: `.dtx`-only with no
published built class. So the extension tells you it's stale and suggests
deleting the bundled copy — letting Overleaf's own TeX Live supply a current one
— rather than writing a file it cannot correctly produce.
</details>

### Speed across projects

**The second project you open costs no download at all.** Three things make that
work:

1. The cache stores the **extracted files** (`acmart.cls` is 122 KB), not the
   15 MB archive they came from. The whole cache is a few hundred KB.
2. **One archive download populates every file** the registry sources from it —
   all seven acmart files land together.
3. Freshness is decided by **version tag first**: if CTAN reports acmart v2.20
   and the cached file says v2.20, it's current by definition and nothing is
   fetched. Otherwise a short TTL applies, and past that a conditional request —
   both CTAN and ACM send `ETag`/`Last-Modified`, and ACM answers
   `If-Modified-Since` with an empty **`304`**.

The options page lists everything cached, with versions and sizes, and can clear
it. The test suite *measures* this rather than assuming it: a second scan is
asserted to make zero further archive requests.

### Mirrors are not trustworthy

`ctan.org/tex-archive/…` is a round-robin redirector across community mirrors,
and they are not uniformly healthy. Observed live, in one sitting:

- one mirror returned a **403 HTML error page**;
- another served a valid-looking but **truncated 4 KB `llncs.cls`** in place of
  the real 43 KB file.

A wrong class file silently written into someone's paper is the worst thing this
tool could do. So raw sources carry **explicit mirror fallbacks**, and every
downloaded class is checked with `expectName` — its `\ProvidesClass` name must
match what was requested — before it can ever be offered as an update.

---

## The `otu` CLI

The extension replaces files. This does the thing file replacement can't: a real
**three-way merge**, so template changes and your own edits to the same file are
reconciled instead of one clobbering the other.

It keeps an orphan `otu/template` branch holding pristine upstream snapshots and
grafts it into your project's history once with `merge -s ours`. Every later
update is then a genuine three-way merge:

```
base   = the template release you started from
ours   = your paper, as you have edited it
theirs = the new template release
```

```bash
node cli/otu.mjs init --project 65f0a1b2c3d4e5f60718293a \
                      --template https://github.com/borisveytsman/acmart.git
node cli/otu.mjs status
node cli/otu.mjs update --dry-run   # predicts conflicts, changes nothing
node cli/otu.mjs update
node cli/otu.mjs push
```

Requires Overleaf git access: **Account Settings → Git integration → generate a
token**, then use your email as the git username and the token as the password.

**Verified behaviour.** A project on template v1.71 whose author rewrote the
title and body, against a template shipping v2.20 that changed both the class and
the boilerplate:

- author's title and body text — **preserved**
- template's new `\acmISBN` line and rewritten conference block — **applied**
- `acmart.cls` — **fully upgraded**, including new macros
- where the author had edited the *same line* the template changed — **conflict
  markers**, never silent loss, and `--dry-run` predicts it beforehand without
  touching the working tree

`.otu.json` goes into `.git/info/exclude`, so it's never committed and never
turns up as a stray file inside your Overleaf project.

---

## Adding a template

Add an entry to [`extension/registry/templates.json`](extension/registry/templates.json):

```json
{
  "id": "mytemplate",
  "name": "My Conference Template",
  "detect": { "documentclass": ["mycls"], "files": ["mycls.cls"] },
  "upstream": { "version": { "kind": "ctan", "pkg": "mycls" } },
  "files": [{
    "name": "mycls.cls",
    "action": "replace",
    "versionFrom": "provides",
    "expectName": "mycls",
    "source": {
      "kind": "raw",
      "url": "https://ctan.org/tex-archive/.../mycls.cls",
      "mirrors": ["https://ctan.math.illinois.edu/macros/latex/contrib/.../mycls.cls"]
    }
  }]
}
```

- `action` — `replace` (a built file exists upstream) or `report-only` (it
  doesn't; say why in `reason`)
- `versionFrom` — `provides`, `bst-header`, or `comment-scan`
- `source` — `{kind:"raw", url, mirrors}` or `{ref, member}` into the shared
  `sources` block for archives
- `expectName` — the `\ProvidesClass` name to verify against before writing

The set of hosts the extension may contact is enforced in `background.js`, **not
in the registry**, so editing the registry cannot widen its network reach. A new
host needs a deliberate edit in two places, and `npm test` asserts the two stay
in agreement.

PRs adding templates are welcome.

---

## Development

```bash
npm test
```

Three suites, 115 assertions:

| Suite | Covers |
|---|---|
| `test/run.js` | parsing, version comparison, diff, registry integrity |
| `test/run-unzip.js` | the ZIP reader, against a real archive |
| `test/run-planner.js` | end-to-end scan through the real service worker, the real ACM archive and live CTAN |

Add `--offline` to `test/run-planner.js` to skip the network-backed portion.

**Fixtures are the genuine upstream files, not hand-written samples.** That is
how two real bugs got caught:

- `llncs.cls` splits its `\ProvidesClass[…]` **across lines** — a line-anchored
  regex silently reports "unknown version";
- IEEEtran uses a **capital `V` with a letter suffix** (`V1.8b`).

Version comparison is component-wise so `2.20 > 2.9`, and suffix-aware so
`1.8b > 1.8`.

To work on the panel without loading the extension into Chrome, serve the repo
and open `test/preview/index.html` (panel) or `test/preview/popup.html` (popup) —
both render the real CSS and JS against mock data covering every state:

```bash
python -m http.server 8731
```

Package the extension with `python tools/package.py`, which validates the
manifest first and writes a zip to `dist/`.

---

## How it works

Overleaf publishes **no REST API for project contents** — `overleaf.com/devs`
documents only the one-way "Open in Overleaf" `/docs` endpoint. So this speaks
the same internal endpoints the established open-source clients use
([pyoverleaf](https://github.com/jkulhanek/pyoverleaf),
[overleaf-sync](https://github.com/moritzgloeckl/overleaf-sync)), using the
session you're already signed in with. **It never handles your password.**

| Endpoint | Used for |
|---|---|
| `GET /project/:id/download/zip` | read the whole project in one request |
| `WSS /socket.io/…` → `joinProjectResponse` | the only source of folder IDs |
| `POST /project/:id/upload?folder_id=…` | create or overwrite a file |
| `DELETE /project/:id/:type/:entityId` | remove a bundled file |

The scan avoids opening a socket at all; it's only used at apply time.

These endpoints are internal and unversioned. Every call is wrapped in an
explicit status check that fails loudly rather than letting a changed response
shape become a silent no-op on your paper.

---

## Honest limitations

**The write path has not been exercised against a live Overleaf project by the
test suite.** Reading, parsing, upstream fetching, diffing and the whole scan
pipeline are covered end-to-end. The upload and delete calls are implemented from
two independent, actively-maintained open-source clients. Keep the backup
checkbox on for your first run.

**Overleaf can change its internal endpoints without notice.** If a scan starts
failing, that's the first thing to suspect; `extension/lib/overleaf.js` is where
they live.

**ACM's portal fingerprints TLS.** It 403s Node/undici even with a browser
User-Agent, while Chrome and curl pass. The extension is unaffected (it uses
Chrome's stack); the test harness borrows curl to stand in for the browser.

**Version detection is best-effort.** Some `.bst` and `.dbx` files carry no
version at all. Those fall back to a SHA-256 comparison against upstream — which
tells you *whether* they differ, but not which is newer.

---

## Privacy

No accounts, no analytics, no tracking, no servers of mine. Your project is read
in your own browser and never leaves it. The only outbound requests are to CTAN,
ACM and GitHub, for the public template files themselves — see
[store/PRIVACY.md](store/PRIVACY.md).

## Licence

[MIT](LICENSE) © 2026 Mark Colley.

**No third-party LaTeX templates are redistributed here.** Class files are
fetched at runtime from their publishers and remain under their own terms —
LPPL for acmart and IEEEtran, Springer's own terms for llncs. See [NOTICE](NOTICE).

*Overleaf* is a trademark of Digital Science & Research Solutions Ltd. This
project is not affiliated with, endorsed by, or connected to Overleaf.
