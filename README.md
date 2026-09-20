# bestony-userscripts

Personal userscripts. Install with [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).

## Scripts

### qqmail-plus.user.js — QQ邮箱增强

For [QQ Mail](https://wx.mail.qq.com/).

| Feature | Where |
| --- | --- |
| One-click view of all unread mail | `未读` button next to the search box |
| Mark the selected mail as read | `标记已读` button in the list toolbar |
| Hides the built-in `全部已读` (mark *everything* read) | list toolbar |

Notes:

- The unread view is the same query the built-in *advanced search → 已读/未读 → 未读* runs; the
  script just writes that condition and navigates to it.
- `标记已读` calls the site's own `/mgr/mailmgr` endpoint (`func=4`) rather than driving the
  `标记为` popup menu, which is unreliable to script. The list view and sidebar unread count are
  updated locally afterwards.
- `window.__qqmailPlus` exposes `openUnreadSearch()`, `markSelectedRead()`, `selectedMailIds()` for
  manual testing from the console.

### xdeck-smart-filter.user.js — X Pro Deck 智能屏蔽

For [X Pro](https://pro.x.com/) decks (`pro.x.com/i/decks/*`).

Filters timeline cards in a deck. Each card is checked in this order:

1. **Blocked users** — if the author's `@handle` is in the block list, the card is hidden
   before any keyword or model work.
2. **Keywords** — the card's text (and author line) is matched against a plain keyword list
   (seeded by `DEFAULT_KEYWORDS`).
3. **JEV** — only if nothing above matches, the text is sent to the [TypeSafe](https://docs.typesafe.ai/api)
   `/v1/systemone` endpoint with the JEV model for a yes/no judgement. When JEV decides to block,
   the author's handle is automatically added to the block list so later posts are hidden immediately.

Matches are hidden. Handles can also be blocked manually from the settings panel or by
right-clicking a card. Config export/import includes both keywords and blocked handles.

## Install

1. Install Tampermonkey.
2. Open the raw `.user.js` file, or paste its contents into a new userscript.


## 参考配置项
https://github.com/bestony/bestony-userscripts/issues/1
