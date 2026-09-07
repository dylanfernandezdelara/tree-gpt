import type { ChatTurn } from "./api";

/**
 * TEMPORARY: stand-in replies used when /api/openrouter fails (for example,
 * no OPENROUTER_API_KEY yet). Lets the UI be exercised end to end. Remove
 * `placeholderReply` from App.tsx once the backend is wired up.
 */

const BLURBS: string[] = [
	`Here's a quick take on that.

The short version is that it depends on what you're optimizing for. If speed matters most, start simple and measure before adding anything clever. If correctness matters most, write the boring version first and keep it until it's proven wrong.

Either way, the best next step is usually the smallest one you can verify.`,

	`A few things worth considering:

- **Start with the constraint.** Most decisions get easier once you name the one thing you can't compromise on.
- **Keep a short feedback loop.** Try it, look at the result, adjust.
- **Write down what you expected.** It makes surprises obvious later.

Want me to go deeper on any of these?`,

	`Sure. Here's a minimal example:

\`\`\`ts
function greet(name: string): string {
	return \`Hello, \${name}!\`;
}

console.log(greet("world"));
\`\`\`

It takes a name, builds a greeting, and returns it. You can drop this into any TypeScript file and run it as is.`,

	`## Overview

There are two common approaches here, and they trade off in predictable ways.

### Option A
Simple to set up and easy to reason about. It works well until the data grows or the rules get complicated.

### Option B
More moving parts up front, but it scales cleanly and keeps the edge cases in one place.

For a first version, Option A is usually enough. Switch when you feel the pain, not before.`,

	`> The trick is not to make the right decision, but to make the decision right.

That said, here's how I'd frame it: list the options, cross out the ones you'd regret, and pick the cheapest of what's left. You can always revisit once you have real information instead of guesses.`,

	`Here's a comparison at a glance:

| Approach | Setup effort | Flexibility | Best for |
|---|---|---|---|
| Quick script | Low | Low | One-off tasks |
| Small library | Medium | Medium | Repeated use |
| Full service | High | High | Shared by many |

If you tell me more about the scale you have in mind, I can point you at one of these.`,
];

let lastIndex = -1;

export async function placeholderReply(
	history: ChatTurn[],
	signal: AbortSignal,
): Promise<string> {
	await delay(600 + Math.random() * 600, signal);

	let index = Math.floor(Math.random() * BLURBS.length);
	if (index === lastIndex) {
		index = (index + 1) % BLURBS.length;
	}
	lastIndex = index;

	const prompt = history[history.length - 1]?.content.trim() ?? "";
	const lead = prompt ? `You asked: *${prompt.slice(0, 80)}*\n\n` : "";
	return `${lead}${BLURBS[index]}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}
