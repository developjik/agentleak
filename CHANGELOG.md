# Changelog

## 0.1.1

- Docs: README (en/ko) now names the unscoped `agentleak` npm package as a different author's package — install with the `@developjik` scope (DEV-36).
- Markdown report: the "Reproduce" block now suggests `npx -y @developjik/agentleak scan …` instead of the unscoped `npx agentleak`, which would install the other author's package (DEV-36).

## 0.1.0

- Initial release: `agentleak scan` diffs what a page shows people vs AI crawlers (hidden text, HTML/JSON-LD instructions, invisible Unicode, User-Agent-dependent responses).
