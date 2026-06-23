import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./alert";

const meta = {
  title: "Components/Alert",
  component: Alert,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

// The four documented alert intents. Info/warning/success tint a smui-* aurora
// color at 25% border / 4% background; error uses the built-in destructive
// variant.
export const Intents: Story = {
  render: () => (
    <div className="flex w-[28rem] max-w-full flex-col gap-3">
      <Alert className="border-smui-frost-2/25 bg-smui-frost-2/[0.04] [&>svg]:text-smui-frost-2">
        <Info className="h-3.5 w-3.5" />
        <AlertTitle className="text-smui-frost-2">telemetry sync</AlertTitle>
        <AlertDescription>Relay handshake completed on channel 7.</AlertDescription>
      </Alert>

      <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
        <TriangleAlert className="h-3.5 w-3.5" />
        <AlertTitle className="text-smui-yellow">reactor standby</AlertTitle>
        <AlertDescription>Output throttled to 64% pending coolant cycle.</AlertDescription>
      </Alert>

      <Alert className="border-smui-green/25 bg-smui-green/[0.04] [&>svg]:text-smui-green">
        <CircleCheck className="h-3.5 w-3.5" />
        <AlertTitle className="text-smui-green">systems nominal</AlertTitle>
        <AlertDescription>All subsystems reporting within tolerance.</AlertDescription>
      </Alert>

      <Alert variant="destructive">
        <CircleX className="h-3.5 w-3.5" />
        <AlertTitle>hull breach</AlertTitle>
        <AlertDescription>Section D depressurized. Bulkheads sealed.</AlertDescription>
      </Alert>
    </div>
  ),
};
