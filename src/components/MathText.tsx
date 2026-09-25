import katex from "katex";
import { Fragment, memo } from "react";
import "katex/dist/katex.min.css";
import { splitMath } from "../lib/math";

/**
 * Text shown as typed, with only its math typeset: for user messages and
 * quotes, where markdown would eat `*`, `#` and backslashes. `inline` sets
 * display math inline too, for one-line previews.
 */
export const MathText = memo(function MathText({ text, inline = false }: { text: string; inline?: boolean }) {
	const segments = splitMath(text);
	if (segments.length === 1 && segments[0].kind === "text") {
		return <>{text}</>;
	}
	return (
		<>
			{segments.map((segment, i) =>
				segment.kind === "text" ? (
					<Fragment key={i}>{segment.text}</Fragment>
				) : (
					<span
						key={i}
						// KaTeX output with `trust` off: no links, classes or raw HTML from the TeX.
						dangerouslySetInnerHTML={{
							__html: katex.renderToString(segment.tex, {
								displayMode: segment.display && !inline,
								throwOnError: false,
							}),
						}}
					/>
				),
			)}
		</>
	);
});
