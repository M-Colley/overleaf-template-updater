"""Build git fixtures for exercising cli/otu.mjs.

Simulates the situation the CLI exists for:
  - a template repo that releases v1.71 then v2.20, changing BOTH the class
    file and the boilerplate in main.tex
  - a project that started from v1.71 and whose author has since rewritten the
    title and body of main.tex

A file-copy updater would destroy the author's text. A three-way merge should
keep it and still pick up the template's changes.

    python test/build_cli_fixture.py <workdir>
"""
import os
import shutil
import subprocess
import sys

BS = chr(92)

CLS_V1 = f"""{BS}ProvidesClass{{acmart}}[2020/04/30 v1.71 ACM]
{BS}LoadClass{{article}}
{BS}newcommand{{{BS}acmDOI}}[1]{{{BS}def{BS}@acmDOI{{#1}}}}
"""

CLS_V2 = f"""{BS}ProvidesClass{{acmart}}[2026/08/16 v2.20 ACM]
{BS}LoadClass{{article}}
{BS}newcommand{{{BS}acmDOI}}[1]{{{BS}def{BS}@acmDOI{{#1}}}}
{BS}newcommand{{{BS}acmISBN}}[1]{{{BS}def{BS}@acmISBN{{#1}}}}
{BS}RequirePackage{{hyperref}}
"""

MAIN_V1 = f"""{BS}documentclass[sigconf]{{acmart}}
{BS}acmConference{{CHI}}{{2020}}{{Honolulu}}
{BS}begin{{document}}
{BS}title{{Title}}
{BS}author{{Author}}
{BS}maketitle
YOUR PAPER HERE
{BS}end{{document}}
"""

# Template v2.20 rewrites the conference block and adds an ISBN line.
MAIN_V2 = MAIN_V1.replace(
    f"{BS}acmConference{{CHI}}{{2020}}{{Honolulu}}",
    f"{BS}acmConference[CHI '26]{{CHI Conference}}{{2026}}{{Yokohama}}\n"
    f"{BS}acmISBN{{978-1-4503-0000-0}}",
)

# The author's own edits: a real title and real body text.
MAIN_AUTHOR = MAIN_V1.replace(
    f"{BS}title{{Title}}", f"{BS}title{{Trust in Automated Vehicles}}"
).replace(
    "YOUR PAPER HERE",
    f"We ran a study with 24 participants.{BS}{BS}\nResults were significant.",
)

ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
}


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write(d, name, text):
    with open(os.path.join(d, name), "w", newline="\n") as fh:
        fh.write(text)


def _force_remove(func, path, _exc):
    """git marks objects read-only, which blocks rmtree on Windows."""
    os.chmod(path, 0o700)
    func(path)


def main(work):
    if os.path.exists(work):
        shutil.rmtree(work, onexc=_force_remove)
    os.makedirs(work)

    template = os.path.join(work, "template")
    os.makedirs(template)
    git(template, "init", "-q", "-b", "main")
    git(template, "config", "core.autocrlf", "false")
    write(template, "acmart.cls", CLS_V1)
    write(template, "main.tex", MAIN_V1)
    git(template, "add", "-A")
    git(template, "commit", "-qm", "template v1.71")
    git(template, "tag", "v1.71")

    project = os.path.join(work, "project-origin")
    os.makedirs(project)
    git(project, "init", "-q", "-b", "main")
    git(project, "config", "core.autocrlf", "false")
    write(project, "acmart.cls", CLS_V1)
    write(project, "main.tex", MAIN_V1)
    git(project, "add", "-A")
    git(project, "commit", "-qm", "start from ACM template v1.71")
    write(project, "main.tex", MAIN_AUTHOR)
    git(project, "add", "-A")
    git(project, "commit", "-qm", "write the paper")

    write(template, "acmart.cls", CLS_V2)
    write(template, "main.tex", MAIN_V2)
    git(template, "add", "-A")
    git(template, "commit", "-qm",
        "template v2.20: acmISBN macro, hyperref, updated conference block")
    git(template, "tag", "v2.20")

    diff = subprocess.run(["git", "diff", "--stat", "v1.71", "v2.20"],
                          cwd=template, env=ENV, capture_output=True, text=True)
    print("template v1.71 -> v2.20 changes:")
    print(diff.stdout.rstrip())
    print(f"\nfixtures in {work}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "cli-fixture")
