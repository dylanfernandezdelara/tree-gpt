import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "./Icons";

const MAX_HEIGHT = 208;

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	/** A reply is loading in the open chat: show Stop instead of Send. */
	streaming: boolean;
	/** A reply is loading somewhere: sending is blocked. */
	busy: boolean;
};

export function Composer({ value, onChange, onSend, onStop, streaming, busy }: Props) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const canSend = value.trim() !== "" && !busy;

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
		el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
	}, [value]);

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (streaming) {
			onStop();
		} else if (canSend) {
			onSend();
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
			return;
		}
		event.preventDefault();
		if (canSend) {
			onSend();
		}
	}

	return (
		<form
			className="composer"
			onSubmit={handleSubmit}
			onClick={() => textareaRef.current?.focus()}
		>
			<textarea
				ref={textareaRef}
				className="composer__input"
				rows={1}
				placeholder="Ask anything"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={handleKeyDown}
				autoFocus
				autoComplete="off"
			/>
			{streaming ? (
				<button
					type="submit"
					className="composer__button composer__button--stop"
					aria-label="Stop generating"
					title="Stop generating"
				>
					<StopIcon />
				</button>
			) : (
				<button
					type="submit"
					className="composer__button composer__button--send"
					aria-label="Send message"
					title="Send message"
					disabled={!canSend}
				>
					<SendIcon />
				</button>
			)}
		</form>
	);
}
