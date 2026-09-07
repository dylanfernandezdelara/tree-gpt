import { useState, type FormEvent } from "react";
import { AuthBar } from "./AuthBar";

type ChatResponse =
	| { ok: true; model: string; message: string }
	| { ok: false; error: string; details?: string };

function App() {
	const [prompt, setPrompt] = useState("");
	const [status, setStatus] = useState<"idle" | "loading">("idle");
	const [result, setResult] = useState<ChatResponse | null>(null);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const message = prompt.trim();
		if (!message || status === "loading") {
			return;
		}

		setStatus("loading");
		setResult(null);

		try {
			const response = await fetch("/api/openrouter", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
			});
			const data: unknown = await response.json();
			setResult(parseChatResponse(data));
		} catch {
			setResult({ ok: false, error: "Request failed" });
		} finally {
			setStatus("idle");
		}
	}

	return (
		<main>
			<h1>treeGPT</h1>
			<AuthBar />
			<form onSubmit={onSubmit}>
				<input
					type="text"
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					placeholder="Type a message"
					disabled={status === "loading"}
					autoComplete="off"
				/>
				<button type="submit" disabled={status === "loading" || prompt.trim() === ""}>
					{status === "loading" ? "Sending…" : "Send"}
				</button>
			</form>
			{result ? <p>{formatResult(result)}</p> : null}
		</main>
	);
}

function parseChatResponse(data: unknown): ChatResponse {
	if (typeof data !== "object" || data === null || !("ok" in data)) {
		return { ok: false, error: "Unexpected response from /api/openrouter" };
	}

	if (data.ok === true && "model" in data && "message" in data) {
		if (typeof data.model === "string" && typeof data.message === "string") {
			return { ok: true, model: data.model, message: data.message };
		}
	}

	if (data.ok === false && "error" in data && typeof data.error === "string") {
		return {
			ok: false,
			error: data.error,
			details:
				"details" in data && typeof data.details === "string"
					? data.details
					: undefined,
		};
	}

	return { ok: false, error: "Unexpected response from /api/openrouter" };
}

function formatResult(result: ChatResponse): string {
	if (result.ok) {
		return result.message;
	}

	return result.details ? `${result.error}: ${result.details}` : result.error;
}

export default App;
