import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import {
	CHAT_MODELS,
	MODEL_EFFORTS,
	effortLabel,
	type EffortId,
	type ModelId,
} from "../../worker/tree-types";
import {
	ModelSelector as AISelector,
	ModelSelectorContent as AIContent,
	ModelSelectorEmpty as AIEmpty,
	ModelSelectorGroup as AIGroup,
	ModelSelectorInput as AIInput,
	ModelSelectorItem as AIItem,
	ModelSelectorList as AIList,
	ModelSelectorName as AIName,
	ModelSelectorTrigger as AITrigger,
} from "./ai-elements/model-selector";

type Props = {
	model: ModelId;
	value: EffortId;
	onChange: (effort: EffortId) => void;
};

/**
 * Reasoning-effort picker. Built on the same AI Elements palette primitives
 * as the model selector, so the modal, blur, search, and keyboard behavior
 * are identical — only the rows differ.
 */
export function EffortSelector({ model, value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const modelLabel = CHAT_MODELS.find((entry) => entry.id === model)?.label ?? model;

	return (
		<AISelector open={open} onOpenChange={setOpen}>
			<div className="effort-selector">
				<span className="effort-selector__label">Effort</span>
				<AITrigger
					render={
						<button
							type="button"
							className="effort-selector__trigger"
							aria-label="Reasoning effort"
						/>
					}
				>
					<span className="effort-selector__trigger-name">{effortLabel(value)}</span>
					<ChevronsUpDown className="effort-selector__trigger-chevron" aria-hidden="true" />
				</AITrigger>
			</div>
			<AIContent title="Choose reasoning effort">
				<AIInput placeholder="Search efforts..." />
				<AIList>
					<AIEmpty>No efforts found.</AIEmpty>
					<AIGroup heading={modelLabel}>
						{MODEL_EFFORTS[model].map((effort) => (
							<AIItem
								key={effort}
								value={effortLabel(effort)}
								onSelect={() => {
									onChange(effort);
									setOpen(false);
								}}
							>
								<AIName>{effortLabel(effort)}</AIName>
								{effort === value ? <Check aria-label="Selected" /> : null}
							</AIItem>
						))}
					</AIGroup>
				</AIList>
			</AIContent>
		</AISelector>
	);
}
