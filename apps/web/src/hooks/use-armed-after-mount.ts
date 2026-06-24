import { useEffect, useState } from "react";

/**
 * Gate for "don't animate the first appearance". Returns `false` for the first painted
 * frame after `active` first becomes true, then `true` thereafter - so you can apply a
 * CSS transition only once the initial layout has painted. The first render snaps into
 * place; only later changes animate.
 *
 * Use it anywhere a transition would otherwise play on mount/load:
 *
 *   const armed = useArmedAfterMount();           // arm one frame after mount
 *   const armed = useArmedAfterMount(isVisible);  // ...or after it first becomes visible
 *   style={{ transition: armed ? "width 300ms ease-out" : undefined }}
 *
 * The flag latches (never falls back to `false` while mounted), so it suppresses the
 * mount animation without re-suppressing on every data change. Unmount/remount resets
 * it, so each fresh appearance snaps in again.
 */
export function useArmedAfterMount(active = true): boolean {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!active || armed) {
      return;
    }
    // Passive effects run after paint, so the `armed: false` (transition-less) layout
    // has already painted here; arm on the next frame, where geometry is unchanged so
    // turning the transition on doesn't itself animate.
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [active, armed]);

  return armed;
}
