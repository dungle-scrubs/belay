/**
 * E4/A14 spike story (plan 58.6.3 M2) - THROWAWAY. Renders ONE captured session through the read-only
 * ExternalStore adapter (`CapturedSessionThread`) beside Trevor's own transcript rows so the two render
 * paths can be eyeballed for cost/fidelity.
 *
 * To run: copy this file + `external-store-adapter-spike.tsx` into `apps/web/src/session/` (fixing the
 * import below to `./external-store-adapter-spike`) and open Storybook. Kept in artifacts so it never
 * ships (research-only; no adoption).
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { buildCapturedSession, CapturedSessionThread } from "./external-store-adapter-spike";

const meta: Meta<typeof CapturedSessionThread> = {
  title: "Spikes/ExternalStoreAdapter",
  component: CapturedSessionThread,
};
export default meta;

type Story = StoryObj<typeof CapturedSessionThread>;

/** The captured session rendered through the read-only ExternalStore runtime. User text + assistant
 *  reasoning/text render through the stock MessagePrimitive; the tool-call and any status rows fall to
 *  data-trevor-* parts the stock thread does not draw (the visible M3 "lossy view" proof). */
export const CapturedSession: Story = {
  render: () => <CapturedSessionThread log={buildCapturedSession()} />,
};
