# Keyboard hotkeys ledger (`apps/web`)

A registry of every key combination the browser UI must work around before
claiming a new hotkey. Two reasons a combo is unavailable:

1. **Trevor already binds it** - see [What the app binds today](#what-the-app-binds-today).
2. **The browser or OS owns it** - see the per-modifier reservation tables.

Target platforms are **macOS, Windows, and Linux**. A hotkey is only "safe" if
it is free on all three. The tables assume **Chrome/Chromium as the strict
baseline** (it is the least willing to let a page override tab/window combos);
Firefox and Safari are usually equal or more permissive, with the noted
exceptions. Behavior varies by browser version - re-verify before relying on a
`⚠️` row.

> Update this file whenever you add, remove, or move a binding. It is the source
> of truth, not the code.

## Legend

| Mark | Meaning |
| --- | --- |
| ✅ | **Free** - no browser/OS claim on the baseline; safe to bind. |
| ⚠️ | **Interceptable but rude** - `preventDefault()` works, but you are stomping a behavior users expect (find, save, print, history). Override only deliberately and ideally only while a specific element is focused. |
| ⛔ | **Hard-reserved** - the OS or browser owns it; `preventDefault()` does not reliably stop it. Never depend on receiving the event. |
| 📝 | **Text-editing** - the OS/browser consumes it *inside a focused text field* (caret moves, deletes, selection). Free outside inputs, unusable inside them. |
| 🅰️ | **App** - already bound by Trevor (`apps/web`). |

---

## What the app binds today

There are currently **no modifier-based (`Ctrl`/`Cmd`/`Alt`/`Shift`+key)
hotkeys** anywhere in `apps/web` - a `grep` for `ctrlKey`/`metaKey`/`altKey`/`shiftKey`
returns nothing. Every existing binding uses a bare key and is scoped to a
focused region. Avoid re-binding these globally.

| Keys | Scope | Action | Source |
| --- | --- | --- | --- |
| `Esc` | **Global** (`window`) | Cancel the active/pending run; if none, clear the composer draft. | `src/App.tsx` (window `keydown`) |
| `Enter` | Composer `<input>` | Submit the message (form submit). | `src/App.tsx` (`<form onSubmit>`) |
| `ArrowUp` / `ArrowDown` | Composer, **only while slash-menu open** | Move the menu highlight. | `src/App.tsx` `onInputKeyDown` |
| `ArrowUp` | Composer, **menu closed, caret on the first line** (or empty composer) | Recall the previous prompt from history (D-084). Off the first line it moves the caret normally. | `src/App.tsx` `onInputKeyDown` |
| `ArrowDown` | Composer, **menu closed, mid-history-navigation, caret on the last line** | Step forward through recalled prompts; past the newest, restores the draft you started from. | `src/App.tsx` `onInputKeyDown` |
| `Tab` | Composer, **only while slash-menu open** | Complete the highlighted command. | `src/App.tsx` `onInputKeyDown` |
| `Enter` | Composer, **only while slash-menu open** | Complete the command (falls through to submit on an exact match). | `src/App.tsx` `onInputKeyDown` |
| `Esc` | Composer, **only while slash-menu open** | Dismiss the menu (event is swallowed so the global `Esc` does not also fire). | `src/App.tsx` `onInputKeyDown` |
| `Enter` / `Space` | Collapsible message header (`role="button"`) | Toggle the collapsible. | `src/components/chat/message.tsx` |
| any key release | While a text selection is active | Hide the quote-selection toolbar. | `src/components/assistant-ui/quote-selection-toolbar.tsx` (`keyup`) |
| typing / arrows / `Enter` | cmdk popovers (model selector etc.), **only while open** | Filter list / navigate / select. `Enter` is `stopPropagation`-ed. | `src/components/ui/command.tsx`, `model-selector.tsx` |

**Practical takeaway:** treat bare `Esc`, `Enter`, `Tab`, `Space`, and the
arrow keys as taken inside the composer and lists. Everything modifier-based is
currently free for the app - the constraints below are entirely
browser/OS-imposed.

---

## The cross-platform rule (read this first)

Because you want Windows + Linux + macOS, the single most important fact:

- **macOS** uses `⌘ (Cmd)` for app/menu shortcuts. `Ctrl` is mostly free there,
  *except* it doubles as the Emacs-style text-editing layer inside inputs and
  triggers Spaces/Mission Control with arrows.
- **Windows/Linux** have no `Cmd`. `Ctrl` is the primary app modifier, and the
  browser reserves a large chunk of `Ctrl+letter`.

So `Ctrl+<letter>` is the *worst* choice for cross-platform: it collides with
text-editing on macOS and with browser shortcuts on Windows/Linux. The
conventional fix is a **"primary mod" that resolves per platform**:

```ts
const primaryMod = (e: KeyboardEvent) =>
  navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
// => Cmd on macOS, Ctrl on Windows/Linux  (the cmdk / VS Code convention)
```

Then pick a key that is free under *both* `Cmd` (macOS) and `Ctrl`
(Windows/Linux). The genuinely-safe shortlist is small - see
[Globally safe combos](#globally-safe-combos).

---

## `Ctrl` + key

### macOS

`Ctrl` is not the menu modifier, so it is broadly free **outside** text fields.
Two things consume it: the Cocoa Emacs bindings inside inputs, and the OS taking
`Ctrl`+arrows.

| Combo | macOS behavior | Verdict |
| --- | --- | --- |
| `Ctrl+A` | Move caret to start of line | 📝 |
| `Ctrl+E` | Move caret to end of line | 📝 |
| `Ctrl+B` | Move caret back one char (left) | 📝 |
| `Ctrl+F` | Move caret forward one char (right) | 📝 |
| `Ctrl+P` | Move caret up one line (previous) | 📝 |
| `Ctrl+N` | Move caret down one line (next) | 📝 |
| `Ctrl+D` | Forward-delete (delete char to the right) | 📝 |
| `Ctrl+H` | Delete backward (backspace) | 📝 |
| `Ctrl+T` | Transpose the two chars around the caret | 📝 |
| `Ctrl+O` | Insert newline after caret | 📝 |
| `Ctrl+V` | Page down (in multi-line fields) | 📝 |
| `Ctrl+Y` | Yank (paste last `Ctrl+K` kill) | 📝 |
| `Ctrl+K` | Kill to end of line in WebKit/Cocoa; **no-op in Chromium text fields** | 📝 (you observed nothing → you were in Chromium) |
| `Ctrl+↑` | Mission Control | ⛔ OS |
| `Ctrl+↓` | App Exposé / app windows | ⛔ OS |
| `Ctrl+←` / `Ctrl+→` | Switch Spaces (desktops) | ⛔ OS |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle browser tabs (standard; can be no-op with one tab or remapped) | ⛔ browser |
| `Ctrl+<other letters>` (G, I, J, L, M, R, S, U, W, Z, …) | Nothing by default outside inputs | ✅ on macOS only - but check the Windows/Linux column before using |

> The `📝` rows fire **only when a text field is focused**. Outside inputs they
> are free on macOS - but they are reserved on Windows/Linux (next table), so
> they fail the cross-platform bar regardless.

### Windows / Linux

`Ctrl` is the primary app modifier; the browser claims most letters.

| Combo | Action | Verdict |
| --- | --- | --- |
| `Ctrl+T` | New tab | ⛔ cannot override |
| `Ctrl+N` | New window | ⛔ cannot override |
| `Ctrl+W` | Close tab | ⛔ cannot override (Chrome) |
| `Ctrl+Shift+T` | Reopen closed tab | ⛔ |
| `Ctrl+Shift+N` | New incognito window | ⛔ |
| `Ctrl+Shift+W` | Close window | ⛔ |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab | ⛔ |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Previous / next tab | ⛔ |
| `Ctrl+1`…`Ctrl+8` | Jump to tab N | ⛔ |
| `Ctrl+9` | Jump to last tab | ⛔ |
| `Ctrl+Q` | Quit browser (Chrome/Linux) | ⛔ |
| `Ctrl+S` | Save page | ⚠️ |
| `Ctrl+P` | Print | ⚠️ |
| `Ctrl+O` | Open file | ⚠️ |
| `Ctrl+D` | Bookmark this page | ⚠️ |
| `Ctrl+F` | Find in page (common to override for in-app find) | ⚠️ |
| `Ctrl+G` / `Ctrl+Shift+G` | Find next / previous | ⚠️ |
| `Ctrl+H` | History (Chrome) | ⚠️ |
| `Ctrl+J` | Downloads (Chrome) | ⚠️ |
| `Ctrl+K` / `Ctrl+E` | Focus omnibox in search mode (Chrome); `Ctrl+K` focuses search bar (Firefox) | ⚠️ |
| `Ctrl+L` | Focus address bar | ⚠️ (hard in some builds) |
| `Ctrl+U` | View source | ⚠️ |
| `Ctrl+R` / `Ctrl+Shift+R` | Reload / hard reload | ⚠️ |
| `Ctrl+0` / `Ctrl++` / `Ctrl+-` | Reset / zoom in / zoom out | ⚠️ |
| `Ctrl+A` | Select all | 📝 / ⚠️ |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste | 📝 - never rebind |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo | 📝 - never rebind |
| `Ctrl+<remaining letters>` (B, I, M, ;, ', ., /, …) | Mostly free | ✅-ish - confirm per browser |

---

## `Cmd` (⌘) + key - macOS only

Windows/Linux have no `Cmd`. (The physical Windows/`Super`/`Meta` key is
OS-reserved and is not delivered to web pages as a usable modifier.) So **any
`Cmd` shortcut needs a `Ctrl` fallback** for the other platforms - use the
`primaryMod` helper above.

| Combo | macOS behavior | Verdict |
| --- | --- | --- |
| `Cmd+Q` | Quit app | ⛔ OS |
| `Cmd+H` | Hide app | ⛔ OS |
| `Cmd+M` | Minimize window | ⛔ OS |
| `Cmd+Tab` / `` Cmd+` `` | Switch app / window | ⛔ OS |
| `Cmd+Space` | Spotlight | ⛔ OS |
| `Cmd+Shift+3` / `Cmd+Shift+4` / `Cmd+Shift+5` | Screenshots | ⛔ OS |
| `Cmd+W` | Close tab | ⛔ browser |
| `Cmd+T` | New tab | ⛔ browser |
| `Cmd+N` | New window | ⛔ browser |
| `Cmd+Shift+T` / `Cmd+Shift+N` | Reopen tab / new private window | ⛔ |
| `Cmd+1`…`Cmd+9` | Jump to tab N | ⛔ |
| `Cmd+Opt+←` / `Cmd+Opt+→` | Previous / next tab | ⛔ |
| `Cmd+Opt+I` | DevTools | ⛔ / ⚠️ |
| `Cmd+S` / `Cmd+P` / `Cmd+O` / `Cmd+D` / `Cmd+U` | Save / print / open / bookmark / view source | ⚠️ |
| `Cmd+F` / `Cmd+G` | Find / find next | ⚠️ |
| `Cmd+R` / `Cmd+Shift+R` | Reload / hard reload | ⚠️ |
| `Cmd+L` / `Cmd+E` | Focus address bar | ⚠️ |
| `Cmd+[` / `Cmd+]` | History back / forward | ⚠️ |
| `Cmd+0` / `Cmd+=` / `Cmd+-` | Reset / zoom in / zoom out | ⚠️ |
| `Cmd+,` | "Preferences" (app convention) | ⚠️ leave for Settings |
| `Cmd+A` / `Cmd+C` / `Cmd+X` / `Cmd+V` / `Cmd+Z` | Select all / clipboard / undo | 📝 - never rebind |
| **`Cmd+K`** | Nothing in the browser | ✅ - the classic command-palette key |
| **`Cmd+Enter`** | Nothing | ✅ - classic "send / submit" |
| **`Cmd+/`** | Nothing | ✅ - classic "show shortcuts" |
| `Cmd+J` | Downloads (Chrome) - mostly free elsewhere | ⚠️ confirm |
| `Cmd+B` / `Cmd+I` / `Cmd+U` | Free in browser (bold/italic/underline only inside rich editors) | ✅-ish |

---

## `Alt` (Option ⌥) + key

**Avoid `Alt`/`Option` as a hotkey modifier on every platform.** It means
different, conflicting things per OS.

### macOS (Option)

`Option` is the **dead-key / special-character layer**: inside a text field
`Option+<letter>` *inserts a character* rather than firing a shortcut.

| Combo | macOS behavior | Verdict |
| --- | --- | --- |
| `Opt+E`, `Opt+U`, `Opt+N`, `Opt+I`, `Opt+\`` | Accent dead keys (´ ¨ ˜ ˆ \`) | 📝 inserts text |
| `Opt+2`, `Opt+G`, `Opt+R`, `Opt+8`, … | Special chars (™/€, ©, ®, •, …) | 📝 inserts text |
| `Opt+←` / `Opt+→` | Move caret by word | 📝 |
| `Opt+Delete` | Delete previous word | 📝 |
| `Opt+Cmd+I` | DevTools | ⛔ / ⚠️ |
| `Opt+Cmd+←` / `Opt+Cmd+→` | Previous / next tab | ⛔ |
| `Opt+Cmd+Esc` | Force-quit dialog | ⛔ OS |
| `Opt+<letter>` generally | Types a glyph; unreliable as a shortcut | ⛔ avoid |

### Windows / Linux (Alt)

| Combo | Action | Verdict |
| --- | --- | --- |
| `Alt` (tap) | Focus/open the menu bar (Firefox) | ⚠️ |
| `Alt+<letter>` | Menu mnemonics / page `accesskey` targets | ⚠️ unreliable |
| `Alt+D` | Focus address bar | ⛔ / ⚠️ |
| `Alt+←` / `Alt+→` | History back / forward | ⛔ navigation |
| `Alt+Home` | Go to home page | ⚠️ |
| `Alt+F4` | Close window | ⛔ OS |
| `Alt+Tab` | Switch window | ⛔ OS |
| `Alt+Space` | Window system menu | ⛔ OS |

---

## `Shift` + key

**`Shift` is not a standalone hotkey modifier.** On its own with a character it
just produces text or extends a selection:

| Combo | Behavior | Verdict |
| --- | --- | --- |
| `Shift+<letter>` | Types the uppercase letter | 📝 unusable as a hotkey |
| `Shift+<digit>` | Types the shifted symbol (`!`, `@`, …) | 📝 |
| `Shift+←/→/↑/↓` | Extend selection | 📝 |
| `Shift+Tab` | Reverse focus order (and reverse-cycle in lists) | reserved for focus nav |
| `Shift+Enter` | Conventionally "insert newline" in composers (not currently bound here) | reserve for that meaning |

Use `Shift` only as a **secondary** modifier: `Ctrl+Shift+<key>` or
`Cmd+Shift+<key>`. Note the reserved secondary combos already listed -
`Ctrl/Cmd+Shift+T` (reopen tab), `+N` (new window), `+W`, `+Tab`,
`Ctrl+Shift+I`/`J`/`C` (DevTools / downloads / inspector), and
`Cmd+Shift+3/4/5` (macOS screenshots).

---

## Special (non-character) keys

Reserved or meaningful across modifiers, regardless of the letter tables:

| Key | Reserved behavior | Verdict |
| --- | --- | --- |
| `F1` | Help | ⚠️ |
| `F3` / `Shift+F3` | Find next / previous | ⚠️ |
| `F5` / `Ctrl+F5` | Reload / hard reload (Win/Linux) | ⚠️ |
| `F6` | Focus address bar | ⚠️ |
| `F7` | Caret browsing (Win/Linux) | ⚠️ |
| `F11` | Toggle fullscreen | ⚠️ |
| `F12` | DevTools (Win/Linux) | ⛔ / ⚠️ |
| `Backspace` | History back in older browsers (when no field focused) | ⚠️ |
| `Space` / `Shift+Space` | Scroll down / up (when no field focused) | 📝 / ⚠️ + 🅰️ (toggles collapsibles) |
| `Tab` | Move focus | reserved for a11y + 🅰️ |
| `Esc` | 🅰️ cancel run / clear draft / dismiss menu | 🅰️ |
| `Enter` | 🅰️ submit composer / activate control | 🅰️ |
| Arrows | Caret/selection/scroll; `Ctrl`+arrows = Spaces (mac); 🅰️ slash-menu nav | 📝 / ⛔ / 🅰️ |

---

## Globally safe combos

Combinations that are free on **macOS + Windows + Linux** at the baseline, using
the `primaryMod` helper (`Cmd` on macOS, `Ctrl` on Windows/Linux). These are the
ones worth spending on app actions:

| Combo (logical) | macOS | Windows/Linux | Typical use |
| --- | --- | --- | --- |
| `Mod+K` | `Cmd+K` ✅ | `Ctrl+K` ⚠️ omnibox-ish - **scope to focused app, `preventDefault`** | Command palette |
| `Mod+Enter` | `Cmd+Enter` ✅ | `Ctrl+Enter` ✅ | Send / submit |
| `Mod+/` | `Cmd+/` ✅ | `Ctrl+/` ✅ | Show shortcuts help |
| `Mod+Shift+K` | ✅ | ✅ | Secondary action (e.g. clear/delete) |
| `Mod+.` | `Cmd+.` ✅ | `Ctrl+.` ✅ | Quick action / stop |
| `Mod+\` | ✅ | ✅ | Toggle a panel/sidebar |

Caveats:

- `Ctrl+K` on Windows/Linux nudges the omnibox into search mode; it is `⚠️` not
  `✅`, so always `preventDefault()` and only handle it while the app (not the
  browser chrome) is focused. The macOS `Cmd+K` half is fully free, which is why
  `Mod+K` is still the standard palette key.
- Anything in this list still needs a focus guard: do not fire app hotkeys while
  the user is mid-edit in the composer unless the binding is meant to work there
  (e.g. `Mod+Enter` to send).
- Re-verify `⚠️` rows on Firefox and Safari before shipping - this table is the
  Chromium lowest common denominator.

## How to add a binding

1. Follow the existing global-listener pattern (`window` `keydown` reading the
   latest state from a `ref`, as in `src/App.tsx`'s `Esc` handler) so the
   handler never goes stale.
2. Gate on `primaryMod(e)` (not raw `ctrlKey`) for cross-platform actions.
3. `preventDefault()` only for the combo you are claiming, and prefer scoping to
   a focused element over a bare `window` listener when the action is
   contextual.
4. Add a row to [What the app binds today](#what-the-app-binds-today) in the
   same change.
