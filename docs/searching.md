# Searching

Type words and press Enter. A message matches when it contains all of them, in the body, subject, sender or recipient names, attachment names or attachment text. Plurals fold together (`meeting` finds `meetings`). Results are ranked by relevance, or by date via the sort menu.

## Operators

The same syntax as Gmail.

| Operator | Example | Matches |
|---|---|---|
| **from:** / **to:** / **cc:** / **bcc:** | `from:amy`, `to:"Jane Doe"` | Name or address; `to:` covers to, cc and bcc |
| **subject:** | `subject:(budget hearing)` | All words in the subject |
| **"…"** | `"safety surfacing"` | Exact phrase |
| **-** | `-newsletter`, `-from:noreply` | Exclude |
| **OR** / **{ }** | `budget OR invoice`, `from:amy OR from:bob`, `{from:amy to:amy}` | Any of these; `-{…}` excludes all of them |
| **has:** | `has:attachment`, `has:pdf`, `has:spreadsheet`, `has:document`, `has:presentation`, `has:image` | Attachments |
| **filename:** | `filename:contract.docx`, `filename:xlsx` | Attachment file name |
| **after:** / **before:** | `after:2024/01/31 before:2024/03/01` | Dates (`YYYY/MM/DD`, `YYYY-MM-DD`, `MM/DD/YYYY`, `YYYY`), in your time zone |
| **older_than:** / **newer_than:** | `newer_than:6m` | Relative: `d`, `m`, `y` |
| **label:** / **in:** | `label:projects/playground`, `in:sent`, `in:anywhere` | Folders; spam and trash are left out unless named |
| **is:** | `is:starred`, `is:unread`, `is:read` | Your marks, kept in this browser only |
| **larger:** / **smaller:** | `larger:5M` | Raw message size (`K`, `M`, `G`) |

The chips under the search box (From, Any time, Has attachment, To, Is unread) and the advanced-search panel (the sliders icon) edit the same query text.

## Smart search

With smart search on (Settings), the browser downloads a small language model once (23 MB) and the mailbox's vectors, then also finds messages that mean something similar without sharing words. Those appear in a separate **Similar by meaning** section below the exact matches.

| Detail | Value |
|---|---|
| **Model** | `Snowflake/snowflake-arctic-embed-xs`, 8-bit, run with transformers.js on the device |
| **Privacy** | The query never leaves the browser |
| **Cut-off** | Adapts per query: well above the median similarity, close to the best hit, above a model floor (0.5) |
| **Off** | Settings → Smart search, or automatically when the browser asks to save data |

## Keyboard

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous conversation |
| `o` or Enter | Open; expand or collapse a message |
| `u` | Back to the list |
| `n` / `p` | Next / previous message in a conversation |
| `;` / `:` | Expand / collapse all messages |
| `s` | Star |
| `Shift+i` / `Shift+u` | Mark read / unread |
| `/` | Search |
| `g` then `i` / `s` / `t` / `a` | Inbox / Starred / Sent / All Mail |
| `?` | All shortcuts |

## Export

The list menu (⋮) downloads the current folder or search results as CSV: date, sender, recipients, subject, labels, attachments, and a link to each conversation.
