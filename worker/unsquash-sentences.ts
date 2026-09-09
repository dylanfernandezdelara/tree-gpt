/**
 * OpenRouter sometimes resumes a new sentence with no space after `.`
 * ("games.Tomorrow"). Only repair a smash that looks like two prose
 * words: a 4+ letter word after whitespace, then `.`, then a capitalized
 * word. Leaves identifiers, abbreviations, and URLs alone.
 */
export function unsquashSentences(text: string): string {
	return text.replace(/(?<=\s[a-z]{4,})(\.)(?=[A-Z][a-z]+(?:[\s']|$))/g, "$1 ");
}
