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

Filters timeline cards in a deck. Each card is first checked against a plain keyword list
(seeded by `DEFAULT_KEYWORDS`), and only if nothing matches is it sent to the [TypeSafe](https://docs.typesafe.ai/api)
`/v1/systemone` endpoint with the JEV model for a yes/no judgement. Matches are hidden.

Configure at the top of the file:

| Constant | Meaning |
| --- | --- |
| `DEFAULT_API_KEY` | Fallback TypeSafe API key. Empty means keyword-only mode. |
| `MODEL_NAME` | Model id, defaults to `jev-latest`. |
| `BASE_URL` | TypeSafe evaluation endpoint. |
| `DEFAULT_KEYWORDS` | Initial blocklist checked before calling the API. |
| `BLOCK_THRESHOLD` | JEV probability at/above which a card is hidden (default `0.5`). |

Notes:

- Requests go through `GM_xmlhttpRequest` (`@connect api.typesafe.ai`) because X's CSP/CORS
  blocks a page-level `fetch` to a third-party origin.
- Judgements are cached in `localStorage` for 7 days; retries use exponential backoff on
  `429`/`529`/network errors, and at most 2 requests run at once.
- A bottom-right badge shows the blocked count, toggles filtering, and opens a settings panel
  where both the **API Key** and the **keywords** can be set at runtime (persisted in
  `localStorage`, API key stored masked), with *恢复默认* and *清除智能缓存* actions.
- `window.__xdeckFilter` exposes `scan()`, `getKeywords()`, `setKeywords([...])`,
  `setApiKey('...')`, `cache`, and `judge()` for console testing.

## Install

1. Install Tampermonkey.
2. Open the raw `.user.js` file, or paste its contents into a new userscript.
