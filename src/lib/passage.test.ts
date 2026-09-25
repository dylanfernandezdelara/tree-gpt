import { describe, expect, it } from "vitest";
import { locate, selectedText, type Piece } from "./passage";

// Node-free stand-ins: the pure helpers only read `kind` and `text`.
const text = (t: string) => ({ kind: "text", text: t, node: {} as Text }) as Piece;
const math = (t: string) => ({ kind: "math", text: t, el: {} as Element }) as Piece;
const br: Piece = { kind: "break", text: "\n" };

// "The roots of $ax^2$ are" / display / "So $\det(A) \neq 0$ holds."
const pieces: Piece[] = [
	br,
	text("The roots of "),
	math("$ax^2+bx+c=0$"),
	text(" are:"),
	br,
	text("\n"),
	br,
	math("$$x = \\frac{-b}{2a}$$"),
	br,
	text("\n"),
	br,
	text("So "),
	math("$\\det(A) \\neq 0$"),
	text(" holds."),
	br,
];

const all = () => true;
const whole = (p: Extract<Piece, { kind: "text" }>): [number, number] => [0, p.text.length];

describe("selectedText", () => {
	it("reads formulas as TeX and collapses block breaks", () => {
		expect(selectedText(pieces, all, whole)).toBe(
			"The roots of $ax^2+bx+c=0$ are:\n$$x = \\frac{-b}{2a}$$\nSo $\\det(A) \\neq 0$ holds.",
		);
	});

	it("clips the end text nodes and keeps formulas whole", () => {
		const picked = new Set([pieces[1], pieces[2], pieces[3]]);
		const clip = (p: Extract<Piece, { kind: "text" }>): [number, number] =>
			p === pieces[1] ? [4, p.text.length] : p === pieces[3] ? [0, 4] : [0, p.text.length];
		expect(selectedText(pieces, (p) => picked.has(p), clip)).toBe("roots of $ax^2+bx+c=0$ are");
	});
});

describe("locate", () => {
	it("finds a quote that spans text and a formula", () => {
		expect(locate(pieces, "roots of $ax^2+bx+c=0$ are")).toEqual({
			start: { piece: 1, offset: 4 },
			end: { piece: 3, offset: 4 },
		});
	});

	it("finds a quote across a display block, whatever the break whitespace", () => {
		const found = locate(pieces, "are:\n$$x = \\frac{-b}{2a}$$\nSo");
		expect(found).toEqual({ start: { piece: 3, offset: 1 }, end: { piece: 11, offset: 2 } });
	});

	it("round-trips what selectedText produced", () => {
		const quote = selectedText(pieces, all, whole);
		expect(locate(pieces, quote)).not.toBeNull();
	});

	it("misses a quote that is not there", () => {
		expect(locate(pieces, "$ax^3$")).toBeNull();
	});
});
