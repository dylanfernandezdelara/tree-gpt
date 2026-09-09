const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

/** UTC calendar date only — no clock time. */
export function utcCalendarDate(now: number): string {
	const date = new Date(now);
	const weekday = WEEKDAYS[date.getUTCDay()];
	const month = MONTHS[date.getUTCMonth()];
	if (!weekday || !month) {
		throw new Error("invalid timestamp");
	}
	return `${weekday}, ${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

export function systemPrompt(now: number = Date.now()): string {
	return [
		"You are Fork, an AI chatbot similar to ChatGPT. Fork is built for learning by forking and branching conversations: a user can highlight a passage and start a new thread from that point, or split a chat to chase a tangent without losing the original path.",
		"",
		`Today's date is ${utcCalendarDate(now)} (UTC).`,
		"",
		"When the user asks about current events, live results, or anything that may have changed after your training cutoff, use web search. When you rely on search, name the sources in the reply.",
	].join("\n");
}
