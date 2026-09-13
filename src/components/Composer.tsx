import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
} from "react";
import { BorderBeam } from "border-beam";
import { SendIcon, StopIcon } from "./Icons";

const MAX_HEIGHT = 208;

/** Grow the field to its text, up to MAX_HEIGHT, then scroll inside it. */
function fitToContent(el: HTMLTextAreaElement | null) {
	if (!el) {
		return;
	}
	el.style.height = "auto";
	el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
}
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion() {
	const [reduce, setReduce] = useState(
		() => typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION).matches,
	);

	useEffect(() => {
		const media = window.matchMedia(REDUCED_MOTION);
		const update = () => setReduce(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	return reduce;
}

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	/** A reply is loading in the open chat: show Stop instead of Send. */
	streaming: boolean;
	/** A reply is loading somewhere: sending is blocked. */
	busy: boolean;
	/** Focus the text field on mount (only the focused pane should). */
	autoFocus?: boolean;
	/** Lets the pane focus the field later, e.g. when a thread opens in it. */
	inputRef?: RefObject<HTMLTextAreaElement | null>;
};

export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	streaming,
	busy,
	autoFocus = false,
	inputRef,
}: Props) {
	const localRef = useRef<HTMLTextAreaElement>(null);
	const textareaRef = inputRef ?? localRef;
	const canSend = value.trim() !== "" && !busy;
	const reduceMotion = usePrefersReducedMotion();

	// Before paint, so typing never shows a stale box.
	useLayoutEffect(() => {
		fitToContent(textareaRef.current);
	}, [value, textareaRef]);

	/*
	 * Again after paint, because the mount measurement can be taken mid-reflow.
	 * Closing a split pane remounts the survivor's composer while the layout is
	 * still collapsing, and `scrollHeight` read then comes back as the previous
	 * pane's -- an empty box stuck at MAX_HEIGHT, with nothing to correct it
	 * since the effect above only reruns when `value` changes.
	 */
	useEffect(() => {
		fitToContent(textareaRef.current);
	}, [textareaRef]);

	// And whenever the field is re-laid out: a sidebar toggle, a window resize
	// or a horizontal split all rewrap the text at a width nothing else watches.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		let lastWidth = el.getBoundingClientRect().width;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			// Ignore the height changes this very callback causes.
			if (Math.abs(width - lastWidth) < 0.5) {
				return;
			}
			lastWidth = width;
			fitToContent(el);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [textareaRef]);

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

	// The beam breathes around the pill from send until the reply lands, then
	// fades out. The wrapper clips to the pill radius, so it carries the shadow.
	return (
		<BorderBeam
			className="composer-beam"
			active={streaming && !reduceMotion}
			size="pulse-inner"
			colorVariant="ocean"
			theme="light"
			strength={0.65}
		>
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
					autoFocus={autoFocus}
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
		</BorderBeam>
	);
}
