# Contributing

Thanks for helping. Issues and pull requests are both welcome.

## Reporting a problem

Most bugs come from unusual mail. When you can, include:

- the command and its full output;
- the input type (PST, mbox, Maildir, eml) and how it was produced;
- a **minimal, invented** example that reproduces the problem: an `.eml` with fake names and addresses.

Never attach real mailboxes or screenshots of real mail to an issue.

## Making a change

```zsh
make install   # dependencies, including Playwright's Chromium
make test      # pytest and browser tests
make lint      # ruff, Biome, TypeScript
```

- Keep pull requests focused, with a test for the bug or feature.
- Tests and fixtures use fictional data only (`tests/fixtures/make_demo.py` builds the demo mailbox).
- Run `make format` before committing, and `make docs` if you changed the CLI.
- If you change the tokenizer, the index or the Parquet layout, read the ground rules in [docs/development.md](docs/development.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
