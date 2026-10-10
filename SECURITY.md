# Security

Mailbox Viewer renders untrusted email and attachments on public websites, so problems such as script execution, sandbox escapes, requests that leak readers' activity to senders, or credential exposure matter.

## Reporting

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/rahimnathwani/mailbox-viewer/security/advisories/new), not in a public issue. Include steps to reproduce, ideally with an invented `.eml` file. You should get a reply within a week.

## Supported versions

Fixes go into the latest release.

## Design

The [security model](docs/architecture.md#security-model) describes how mail HTML, remote content and attachments are handled.
