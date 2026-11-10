# Changelog

## 0.1.0 (unreleased)

- First version. Answers "what in this checkout can run code, change agent behaviour, or point files outside the repo?" without executing anything from it.
- Git: repo-local config read as text (program-running keys such as `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.pager`, `diff.external`, `filter.*`; includes followed only inside the repo), executable hooks, `.git` files and symlinks.
- Symlinks: working-tree links that resolve outside the repo (through chains), dangling links at names tools write to, and links recorded only in the Git index.
- Agent config: Claude Code settings (hooks, allowlists, bypass mode, MCP auto-approval, env), MCP server files for Claude, Cursor, VS Code and Gemini, Codex `config.toml`, VS Code `folderOpen` tasks, devcontainer lifecycle commands.
- Packages: install-time lifecycle scripts outside `node_modules`, implicit `node-gyp`, Yarn `yarnPath`, npm `script-shell` / `node-options`.
- Instruction files: heuristic checks for hidden Unicode (bidi, tag characters with decoding, zero-width), HTML comments and injection-style lines.
- Human text output, `--json` for agents with invisible characters escaped, exit codes 0/1/2, `--fail-on`, walk and read limits.
