# Rankora AI — Ecommerce SEO Scanner

Zero-dependency Node.js app (Node 22.5+, built-in `node:sqlite`). No `npm install` needed.

## Run on Replit
1. Create a Node.js Repl, upload these files (keep folders), press **Run** (`npm start`).
2. Open the webview. Scans are saved in `data.sqlite`.

## Test
- `npm test` — 9 automated tests (URL validation, SSRF/private-IP/redirect blocking, robots.txt, size limit, parsing, scoring, full scan on a local fixture site, API + DB history).
- Live check: in the app, scan `https://example.com` (small, public) or `https://books.toscrape.com` (a public scraping sandbox store). Expect: HTTPS ✓, pages listed, score breakdown, missing meta/alt findings, CSV download.
- Safety check: try `http://localhost`, `http://169.254.169.254`, `10.0.0.1` — all rejected.

## Scoring (100 pts)
Technical 25 · Titles & Descriptions 25 · Headings & Content 20 · Images 15 · Links & Canonicals 15. Every sub-check shows points earned/max in the UI.

## Honest limits
Keywords are extracted from page text only — not search volume or rankings. No Google, traffic, sales, or AI integrations. Single-process, in-memory rate limit. JS-rendered sites are read as raw HTML only.
