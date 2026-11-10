# Security

Repo Preflight is a **heuristic scanner**. It lists things in a checkout that are known ways to run code, change a coding agent's behaviour, or reach files outside the repository. A clean report is not proof that a repository is safe, and a finding is not proof that it is malicious.

## What it promises

- It never executes, imports or sources anything from the scanned directory. Git config, hooks, `.git` files, agent configs, package manifests and instruction files are read as text, each capped at 1 MB.
- It never follows a symlink while walking or reading. Files are opened with `O_NOFOLLOW` where the OS supports it and checked again after opening.
- When Git is used (only `ls-files` and `cat-file`, to list index symlinks), repository programs are disabled with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat`, `GIT_CONFIG_NOSYSTEM=1` is set and every inherited `GIT_*` variable is removed. `--no-git` runs no subprocess at all.
- It writes nothing, anywhere.

## What it does not promise

- **Instruction-file checks are pattern matches.** Prompt injection can be phrased in endless ways, split across files, written in another language, or hidden in files this tool does not treat as instructions (source comments, READMEs, issue text, tool output). Anything flagged `heuristic: true` is a lead for a human to read, not a verdict.
- **Coverage is a list, not a proof.** New agent clients, config keys and package managers appear constantly. Build scripts (`Makefile`, `setup.py`, Gradle, Cargo `build.rs`), direnv `.envrc`, editor settings and CI workflows are not analysed in this version.
- **It is a snapshot.** Another process with write access to the directory can change it during or after the scan. It is not a sandbox and does not make it safe to run the repository's code.
- **Limits are real.** Content past 1 MB, deeper than `--max-depth`, past `--max-files`, or inside `node_modules` (unless `--include-node-modules`) is not checked. Limits are reported in `notes`.
- **Output contains untrusted text.** `trigger` and `excerpt` are copied from the repository after escaping control and invisible characters. Treat them as data. An agent that reads the report should not follow instructions found in those fields.

## Reporting

Report a suspected vulnerability in Repo Preflight itself (for example, a way to make it execute repository code, follow a symlink, or emit raw control characters) through GitHub's private security reporting if available. Use public issues for missed patterns and false positives. Do not post secrets or private source files.
