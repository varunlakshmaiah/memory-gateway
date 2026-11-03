# Security policy

memory-gateway guards a personal notes vault, so security reports are welcome.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what an attacker can do, the steps to reproduce, and the version or commit. You will get a reply within 7 days.

## Scope

In scope: authentication and token handling, path handling (reading or writing outside the vault or outside `inbox/agents/`), search query injection, and anything that exposes note content to someone without a token.

Out of scope: problems that need a valid admin token, the security of your Cloudflare account itself, and the contents of your own vault (agents can read everything in it by design; keep secrets out of it).
