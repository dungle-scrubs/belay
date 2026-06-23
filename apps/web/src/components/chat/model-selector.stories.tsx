import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { type ModelOption, ModelSelector } from "@/components/assistant-ui/model-selector";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const MODELS: ModelOption[] = [
  { id: "qwen", name: "Qwen 27B 4-bit (local)" },
  { id: "gpt", name: "GPT-5.5", efforts: true },
];

const THINKING = ["low", "medium", "high"];
const onClasses =
  "text-ui lowercase data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

// Model dropdown (assistant-ui) with a fixed-width trigger, plus a *separate*
// always-visible thinking selector - so changing the level is one click, not two.
// The thinking control only appears for models that support efforts.
function Demo() {
  const [model, setModel] = useState("gpt");
  const [thinking, setThinking] = useState("medium");
  const hasEfforts = Boolean(MODELS.find((m) => m.id === model)?.efforts);

  return (
    <div className="flex items-center gap-3">
      <ModelSelector.Root models={MODELS} value={model} onValueChange={setModel}>
        <ModelSelector.Trigger className="w-64" />
        <ModelSelector.Content>
          <ModelSelector.Search />
          <ModelSelector.List />
        </ModelSelector.Content>
      </ModelSelector.Root>

      {hasEfforts ? (
        <div className="flex items-center gap-2">
          <span className="text-label tracking-wider uppercase text-muted-foreground">
            thinking
          </span>
          <ToggleGroup
            type="single"
            value={thinking}
            onValueChange={(next) => {
              if (next) {
                setThinking(next);
              }
            }}
            variant="outline"
            size="sm"
          >
            {THINKING.map((level) => (
              <ToggleGroupItem key={level} value={level} className={onClasses}>
                {level}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
    </div>
  );
}

const meta: Meta = {
  title: "Components/ModelSelector",
  parameters: { layout: "centered" },
};

export default meta;

type Story = StoryObj;

export const WithThinking: Story = {
  render: () => <Demo />,
};
