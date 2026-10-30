# Security reporting

CodeMe handles local source files, reviewed edits, command execution, local model servers, and optional model downloads. Security reports should identify the affected version or commit, client, operating system, provider, relevant trust boundary, and a minimal safe reproduction.

## Report privately first

Use **Security → Report a vulnerability** on [the repository](https://github.com/DattaDhebe/codeme) if GitHub offers that control. Its availability depends on the repository's settings; this document does not claim private reporting is enabled.

If that route is unavailable, contact **support@dhebe.com** with the subject **CodeMe security report**, or use an established private channel with the maintainer. Start with a short description and arrange a safe way to share details. Do not send live credentials, user databases, private code, payment records, or unnecessary personal information. If you cannot establish a private route, open an issue asking for one without disclosing the weakness.

Do not publish working exploit details or another user's information in a normal bug report. Use disposable projects and accounts for reproductions. Do not charge a payment account, access another customer's purchase, damage files, or test third-party systems to demonstrate a report.

## Useful report details

- Exact commit or development version and the affected browser/extension/backend path.
- Preconditions, expected protection, and observed behavior.
- A minimal synthetic fixture or redacted request that reproduces the issue.
- Potential impact and any suggested correction, without including secrets.

Examples of relevant boundaries include workspace escapes or symlink handling; edits without matching source reads or approval; model-controlled commands or executable settings; forged verification/completion records; hosted inference fallback; private data exposure; unsafe model-download selection; and bypasses of a paid-download entitlement when that product becomes active.

## Scope and maintenance

Current development targets the maintained source and the **0.7.0** application line. No long-term-support window, backport schedule, bounty, or response-time commitment is advertised. A private report is not an acknowledgement that a vulnerability exists; investigation and a correction still need evidence.

The local model server and the user's project scripts are separate software. Approval does not make an arbitrary project test safe. Report a CodeMe boundary failure here and use the relevant upstream project's reporting process for a flaw confined to a dependency or runtime. Avoid attaching complete conversations or source trees when a small fixture is enough.
