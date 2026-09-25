import { describe, expect, it } from "vitest";
import { normalizeMath } from "./math";

describe("normalizeMath", () => {
	it("turns \\( \\) into inline $ math", () => {
		expect(normalizeMath("Area is \\( \\pi r^2 \\).")).toBe("Area is $\\pi r^2$.");
	});

	it("turns multi-line \\[ \\] into a $$ block", () => {
		expect(normalizeMath("So\n\\[\nx = 1\n\\]\ndone")).toBe("So\n$$\nx = 1\n$$\ndone");
	});

	it("fences one-line $$…$$ and \\[…\\] so they display, keeping list indent", () => {
		expect(normalizeMath("$$x^2$$")).toBe("$$\nx^2\n$$");
		expect(normalizeMath("- item\n  \\[ y \\]")).toBe("- item\n  $$\n  y\n  $$");
	});

	it("escapes money so it is not typeset", () => {
		expect(normalizeMath("It costs $5 and $1,200.50.")).toBe("It costs \\$5 and \\$1,200.50.");
		expect(normalizeMath("$5/month or $1,200 a year")).toBe("\\$5/month or \\$1,200 a year");
		expect(normalizeMath("$2$ and $2x + 1$ cost $3")).toBe("$2$ and $2x + 1$ cost \\$3");
	});

	it("leaves code blocks and code spans alone", () => {
		const code = "```\necho \\(x\\) $5\n```\nuse `$5` or `\\(a\\)`";
		expect(normalizeMath(code)).toBe(code);
	});

	it("wraps a bare display environment in $$ and drops \\label", () => {
		const align = "Then\n\\begin{align}\\label{eq:1}\na &= b \\\\\nc &= d\n\\end{align}\ndone";
		expect(normalizeMath(align)).toBe(
			"Then\n$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$\ndone",
		);
		expect(normalizeMath("\\begin{pmatrix} 1 & 2 \\end{pmatrix}")).toBe(
			"$$\n\\begin{pmatrix} 1 & 2 \\end{pmatrix}\n$$",
		);
	});

	it("leaves environments already in math, unsupported ones, and code alone", () => {
		const inside = "$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$";
		expect(normalizeMath(inside)).toBe(inside);
		const multline = "\\begin{multline}\na + b\n\\end{multline}";
		expect(normalizeMath(multline)).toBe(multline);
		const code = "```latex\n\\begin{align}\na &= b\n\\end{align}\n```";
		expect(normalizeMath(code)).toBe(code);
		expect(normalizeMath("see \\begin{cases} x \\end{cases} inline")).toBe(
			"see \\begin{cases} x \\end{cases} inline",
		);
	});
});
