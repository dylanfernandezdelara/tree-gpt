import { CHAT_MODELS, type ModelId } from "../../worker/tree-types";

type Props = {
	value: ModelId;
	onChange: (model: ModelId) => void;
};

export function ModelSelector({ value, onChange }: Props) {
	return (
		<label className="model-selector">
			<span className="model-selector__label">Model</span>
			<select
				className="model-selector__select"
				value={value}
				aria-label="Chat model"
				onChange={(event) => {
					const next = event.target.value;
					const match = CHAT_MODELS.find((model) => model.id === next);
					if (match) {
						onChange(match.id);
					}
				}}
			>
				{CHAT_MODELS.map((model) => (
					<option key={model.id} value={model.id}>
						{model.label}
					</option>
				))}
			</select>
		</label>
	);
}
