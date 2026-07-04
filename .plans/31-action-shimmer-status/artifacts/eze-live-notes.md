# Plan 31 - Live EZE test notes (M5)

Deterministic coverage (unit + web + stories) proves the label projection and the shimmer render.
These notes cover the live-model observations an owner should confirm against a running host, since
they depend on real provider timing and transport events that the hermetic suite does not exercise.

Run: `pnpm dev:op` (or `trevor`), open a session, and confirm each label shimmers (not a pulse dot)
and reads as the deterministic text below.

1. **Silent model delay** - submit a prompt to a warm local model that pauses before its first
   token. Expect the silent-turn row to shimmer `thinking`; a cold model instead shimmers
   `loading <model>` until weights are up.
2. **Running read/search tool** - ask for something that triggers `read`/`grep`. The running tool
   body shimmers `reading <path>` / `searching <pattern>`; the settled row does not animate.
3. **Long bash command** - run a multi-line/long shell command. The running label shimmers
   `running <cmd>` collapsed to a single ≤48-char line with an ellipsis - never multiline, never the
   full command line.
4. **Reconnect / recovery** - kill the socket mid-turn (or restart the host). Expect the reconnect
   marker to read `reconnecting (attempt n/m)`; after an overflow-recovery, the retry status stays
   short and structured (no raw provider text).
5. **Reduced motion** - enable macOS "Reduce motion" (System Settings > Accessibility > Display).
   Every label stays fully readable with the shimmer band frozen (no motion), confirming
   `motion-reduce:animate-none`.

Viewport: confirm both a desktop-width and a narrow (~360px) transcript - the shimmer overlay is
sized by the base text, so the label must not shift layout width as it animates.
