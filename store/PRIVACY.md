# Privacy Policy — Template Updater for Overleaf

_Last updated: 27 August 2026_

## Short version

The extension collects nothing, sends nothing anywhere, and has no server. Your
project is read inside your own browser and never leaves it.

## What the extension does with your data

To tell you whether your template is out of date, the extension has to read your
project. It does this by asking Overleaf — the same Overleaf you are already
signed in to, in the same browser tab — for a copy of the project, and unpacking
it in memory.

That content is used only to answer one question: which template files are in
this project, and what version is each one? **It is never transmitted anywhere.**
There is no analytics, no telemetry, no crash reporting, no account, and no
backend service operated by this extension or its author.

## Network requests

The extension makes requests to exactly these places, and none of them carry any
information about you or your document:

| Where | Why |
|---|---|
| The Overleaf origin you are on | Read your project, and write the template files you chose to update. Uses your existing session; the extension never sees or handles your password. |
| `ctan.org`, `mirror.ctan.org`, `mirrors.ctan.org` | Look up the current version of a LaTeX package, and download published class and bibliography-style files. |
| `portalparts.acm.org` | Download ACM's official public proceedings template archive. |
| `raw.githubusercontent.com`, `api.github.com` | Download published template files and release version information. |

These are plain requests for public files. They contain no identifiers, no
project content, and no personal data.

The set of hosts the extension may contact is fixed in its source code
(`background.js`) and cannot be widened by the template registry or by anything
on a web page.

## What is stored, and where

Everything is stored locally in your browser, using Chrome's extension storage.
Nothing is synced to any server of ours.

- **Your two preferences** — whether to download a backup before applying, and
  whether to close the panel after a successful update. These use Chrome's
  synced-settings storage, so if you have Chrome Sync enabled they follow your
  Google account, exactly like your other Chrome settings.
- **A cache of public template files** — the upstream `.cls`/`.bst` files
  themselves (a few hundred kilobytes), so opening a second project does not
  re-download them. These are public files, not your content. You can see
  everything cached, and delete it, on the extension's options page.

**Your project content is never written to storage.** It exists only in memory
while a scan is running.

## Downloads

If the backup option is enabled, the extension asks Chrome to download a `.zip`
of your project before it modifies anything. That file is downloaded from
Overleaf to your own computer. It does not pass through anywhere else.

## Permissions

Each permission exists for one specific purpose:

- **Access to `*.overleaf.com`** — to run on your project page and read/write the
  template files.
- **Access to CTAN, ACM and GitHub** — to fetch the public upstream template
  files.
- **`storage`** — the two preferences and the template-file cache described above.
- **`downloads`** — the pre-update backup of your own project.
- **`scripting`** — only to start running on a self-hosted Overleaf instance
  after you have explicitly granted permission for that specific domain.
- **Optional access to other sites** — never granted automatically. It is used
  only when you click *Enable on `<host>`* for one domain you choose, so the
  extension can work with a university-hosted Overleaf.

## Third parties

There are none. No data is sold, shared, or transferred to anyone. There are no
advertising, analytics, or tracking services in this extension.

## Children

The extension is a tool for academic writing and is not directed at children.

## Changes

If this policy ever changes, the updated version will be published at this same
address with a new date at the top.

## Contact

Questions, or a security issue to report? Open an issue on the project's
repository.
