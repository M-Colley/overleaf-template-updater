# Chrome Web Store submission

> **Not currently submitted.** This extension is distributed from this
> repository as an unpacked extension. This document is kept so a store
> submission is a short step rather than a research project, and because the
> permission justifications below double as plain-English documentation of why
> each permission exists.

Everything needed for the listing. Build the upload with:

```bash
python tools/package.py
```

That validates the manifest first (it already caught a 201-character description
against the store's hard 132 limit) and writes
`dist/template-updater-for-overleaf-<version>.zip`.

---

## Two things to decide before you submit

### 1. The name was changed — check you agree

`Overleaf Template Updater` → **`Template Updater for Overleaf`**

Leading with a trademark reads as an official product of that trademark's owner,
which the store's branding policy treats as misleading. `X for Y` is the
established pattern for third-party add-ons, and the description carries an
explicit non-affiliation line. If you would rather keep the original name,
change `name` in `extension/manifest.json` — but expect it to be a rejection
risk, and Overleaf is a Digital Science trademark.

### 2. `optional_host_permissions: ["https://*/*"]`

This is what lets someone enable the extension on a university-hosted **Overleaf
Server Pro** instance, whose domain no static pattern can predict. It is
*optional* — nothing is granted until the user clicks **Enable on `<host>`** in
the popup — which is exactly the pattern Google prefers over requesting broad
access up front. It is still a broad pattern and may add review time.

If you do not need self-hosted support (you are on `de.overleaf.com`, which the
static patterns already cover), delete the `optional_host_permissions` key and
the `scripting` permission from the manifest and resubmit. The popup degrades
gracefully — it just stops offering the *Enable on…* button.

---

## Listing fields

**Name** (29/75)

```
Template Updater for Overleaf
```

**Short description** (125/132 — this is the `description` in the manifest)

```
Checks your Overleaf project's LaTeX template (ACM, IEEE, Springer, Elsevier, ACL, CVPR, LIPIcs and more) for newer releases.
```

**Category:** Workflow & Planning
**Language:** English

**Detailed description**

```
Overleaf copies a template into your project once, when you create it, and never
looks back. When ACM ships a new acmart, your CHI submission is still on whatever
version it was forked from - and there is no "update template" button, because
from Overleaf's point of view your project is not a copy of anything.

This extension adds one.

Open a project and click the Template button. It reads the project, works out
which template it uses and which version, compares that against the current
upstream release, and shows you a line-by-line diff of exactly what would change.
Nothing is written until you tick the files you want and press Apply.

WHAT IT UPDATES
- ACM: acmart.cls, ACM-Reference-Format.bst and the acm biblatex files (CHI,
  CSCW, UIST, AutomotiveUI, IMWUT, ACM journals)
- IEEE: IEEEtran.cls and its bibliography styles
- Springer LNCS: llncs.cls and splncs04.bst
- Elsevier: the CAS templates (cas-sc, cas-dc) and the elsarticle bibliography
  styles
- ACL, EMNLP and NAACL (acl.sty); CVPR (cvpr.sty); TMLR (tmlr.sty)
- LIPIcs and OASIcs (ICALP, STACS, SoCG, ...); CEUR-WS workshop proceedings
- MNRAS, AAS journals (AASTeX), Oxford University Press, ASME, JACoW, Quantum,
  IACR journals
- Detected and reported, never guessed at: elsarticle.cls, REVTeX, APA 7,
  achemso, JMLR/PMLR and GI LNI (their publishers ship no compiled class file),
  and AASTeX 6, which AASTeX 7 replaced under a new name

WHAT IT WILL NOT TOUCH
It only ever writes class, style and bibliography-style files. It never rewrites
a .tex file - that is where your paper lives. Drift in your own preamble is
reported, never silently "fixed".

SAFE BY DEFAULT
- The scan is read-only. Nothing changes until you press Apply.
- A .zip backup of the project is downloaded first (you can turn this off).
- Every change is recorded in Overleaf's own History panel, so it is revertible
  from Overleaf itself.
- Deletions always ask for confirmation.

FAST ACROSS PROJECTS
Upstream files are cached, so the second project you open costs no download at
all. A cached file is reused when the package index confirms its version is
current, and otherwise revalidated with a conditional request.

WORKS WITH
www.overleaf.com, regional hosts such as de.overleaf.com, and - if you grant it -
a self-hosted Overleaf Server Pro instance at your university.

PRIVACY
No accounts, no analytics, no tracking, no servers of ours. Your project is read
in your own browser and never leaves it. The only outbound requests are to CTAN,
ACM and GitHub to fetch the public template files themselves.

Not affiliated with, endorsed by, or connected to Overleaf or Digital Science.
Overleaf is a trademark of Digital Science & Research Solutions Ltd.
LaTeX templates are the property of their respective publishers.

Open source. Issues and new templates welcome.
```

---

## Permission justifications

Paste these into the "Privacy practices" tab. Each field maps to a permission
the reviewer will ask about.

| Permission | Justification |
|---|---|
| `storage` | Stores the user's two preferences (download a backup before applying; close the panel after a successful update) and caches the public upstream template files so opening a second project does not re-download a 15 MB archive. |
| `downloads` | Downloads a .zip backup of the user's own Overleaf project before any file is modified, so a change can always be undone. The file comes from the Overleaf origin the user is already signed in to. |
| `scripting` | Registers the content script on a self-hosted Overleaf instance after the user has explicitly granted permission for that specific domain via the extension's popup. Not used otherwise. |
| Host permission: `*.overleaf.com` | The extension's entire function is reading and updating files in an Overleaf project. It needs to run on the project page to use the session the user is already signed in with. |
| Host permission: `ctan.org`, `mirror(s).ctan.org` | Fetches the current version number and the published class and bibliography-style files (IEEEtran, llncs, Elsevier, MNRAS, AASTeX and others) from CTAN, the canonical LaTeX package archive. |
| Host permission: `portalparts.acm.org` | Downloads ACM's official proceedings template archive. This is the only place a compiled acmart.cls is published; CTAN and GitHub carry only the .dtx source, which cannot be used without running LaTeX. |
| Host permission: `raw.githubusercontent.com`, `api.github.com` | Fetches template files for templates whose publishers maintain them on GitHub rather than CTAN (ACL, CVPR, TMLR, LIPIcs, CEUR-WS). |
| `optional_host_permissions: https://*/*` | Universities commonly run their own Overleaf Server Pro instance on their own domain, which cannot be predicted in advance. Nothing is granted until the user explicitly clicks "Enable on <host>" for one specific domain in the popup. No broad access is requested or held by default. |

**Single purpose statement**

```
Keeping the LaTeX template files in an Overleaf project up to date with their
published upstream releases.
```

**Data usage** — tick these honestly:

- Does **not** collect or transmit personally identifiable information
- Does **not** collect health, financial, authentication, personal communications,
  location, web history, or user activity data
- Website content: the extension reads the user's project files **locally in the
  browser** to identify template files. This content is **never transmitted
  anywhere.**
- Confirm: not sold to third parties; not used for unrelated purposes; not used
  for creditworthiness or lending.

**Privacy policy URL** — required. Host `store/PRIVACY.md` somewhere public
(GitHub Pages or a gist both count) and paste the URL.

---

## Screenshots

Required: at least one, **1280×800** or 640×400 PNG/JPEG. Take these from a real
project — reviewers respond better to genuine screenshots, and yours will be more
convincing than mock-ups:

1. **The panel mid-scan on a real project** — the detected template, an
   `UPDATE AVAILABLE` badge with real version numbers. This is the money shot.
2. **The diff expanded** — "Show what would change" open on `acmart.cls`.
3. **After applying** — the results list plus the auto-close notice.
4. **The popup** — showing it active on the project.
5. *(optional)* **The options page** — the tracked-template table and the cache
   listing, which makes the "no telemetry, here is every URL it touches" claim
   concrete.

For a repeatable mock-up instead, serve the repo and open
`test/preview/index.html` (panel) and `test/preview/popup.html` (popup) at a
1280×800 viewport.

Optional but recommended: a **440×280** small promo tile.

---

## Submission checklist

- [ ] `npm test` passes
- [ ] `python tools/package.py` validates and writes the zip
- [ ] Load the zip's contents unpacked once more and re-test on a real project
- [ ] Decide on the two items at the top (name, optional host permission)
- [ ] Register a Chrome Web Store developer account (one-off $5 fee — do this
      yourself; it needs your Google account and card)
- [ ] Upload the zip, paste the listing copy and permission justifications
- [ ] Add screenshots and the privacy policy URL
- [ ] Set visibility (Unlisted is a good way to trial it with colleagues first —
      it skips nothing in review but keeps it out of search)
- [ ] Submit; expect a few days, longer with the broad optional permission

**Bump `version` in `extension/manifest.json` for every upload** — the store
rejects a re-upload of an existing version number.
