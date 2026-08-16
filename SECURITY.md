# Security

## Trust boundaries

The model is untrusted. Model text, tool arguments, patches, paths, and shell commands are validated before use.

Repository content is also untrusted. Instructions found in source files do not override the extension permission model.

## Defaults

- Model traffic is loopback-only.
- Ask mode is read-only.
- Edit mode cannot execute commands.
- Agent edits require review unless safe auto-apply is enabled.
- Unknown and sensitive commands require approval.
- Obfuscated or raw-device commands are denied.
- File tools are confined to canonicalized workspace roots.
- Symlink escapes and credential-bearing paths are rejected.
- Command environments omit likely secret variables.
- Terminal output is redacted and bounded.
- Commits and pushes are not exposed as dedicated tools.

## Audit privacy

The audit log stores event metadata only. It excludes prompts, source text, patches, reasoning, command bodies, terminal output, and credentials.

## Limitations

The terminal runner is not a macOS sandbox. An approved or auto-approved repository script can perform behavior not apparent from its command name. Review project scripts before granting autonomous execution in an untrusted repository.

Static command classification cannot prove that an arbitrary program is harmless. Unrecognized commands therefore require approval.

The extension can prevent direct file-tool access outside the workspace, but compilers and project scripts may access SDKs, caches, or other paths required by their toolchains.

## Reporting

Do not include repository secrets, tokens, source code, or audit contents in a public vulnerability report. Provide a minimal reproduction that uses synthetic data.
