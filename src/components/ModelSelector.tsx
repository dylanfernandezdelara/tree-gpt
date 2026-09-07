import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { CHAT_MODELS, type ModelId } from "../../worker/tree-types";
import {
  ModelSelector as AISelector,
  ModelSelectorContent as AIContent,
  ModelSelectorEmpty as AIEmpty,
  ModelSelectorGroup as AIGroup,
  ModelSelectorInput as AIInput,
  ModelSelectorItem as AIItem,
  ModelSelectorList as AIList,
  ModelSelectorLogo as AILogo,
  ModelSelectorName as AIName,
  ModelSelectorTrigger as AITrigger,
} from "./ai-elements/model-selector";

type Props = {
  value: ModelId;
  onChange: (model: ModelId) => void;
};

/** Logo provider per allowlisted model (models.dev artwork). */
function providerFor(model: ModelId): string {
  switch (model) {
    case "openai/gpt-5.6-luna":
      return "openai";
    case "qwen/qwen3.7-flash":
      return "alibaba";
    default:
      return "meta";
  }
}

export function ModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = CHAT_MODELS.find((model) => model.id === value) ?? CHAT_MODELS[0];

  return (
    <AISelector open={open} onOpenChange={setOpen}>
      <div className="model-selector">
        <span className="model-selector__label">Model</span>
        <AITrigger
          render={
            <button type="button" className="model-selector__trigger" aria-label="Chat model" />
          }
        >
          <AILogo provider={providerFor(current.id)} />
          <span className="model-selector__trigger-name">{current.label}</span>
          <ChevronsUpDown className="model-selector__trigger-chevron" aria-hidden="true" />
        </AITrigger>
      </div>
      <AIContent title="Choose a chat model">
        <AIInput placeholder="Search models..." />
        <AIList>
          <AIEmpty>No models found.</AIEmpty>
          <AIGroup heading="Models">
            {CHAT_MODELS.map((model) => (
              <AIItem
                key={model.id}
                value={model.label}
                onSelect={() => {
                  onChange(model.id);
                  setOpen(false);
                }}
              >
                <AILogo provider={providerFor(model.id)} />
                <AIName>{model.label}</AIName>
                {model.id === value ? <Check aria-label="Selected" /> : null}
              </AIItem>
            ))}
          </AIGroup>
        </AIList>
      </AIContent>
    </AISelector>
  );
}
