/**
 * The phone-width login decoration: a dozen Fork marks (same geometry as
 * `TreeIcon`) at mixed sizes drifting around the edges of the page, leaving
 * the middle clear for the form. Positions are percentages of the container so
 * the marks hug the edges at any width below `lg`; sizes are fixed pixels so
 * they stay legible on narrow phones and modest on tablets.
 */

// Trunk (brand blue), Leaf, Amber, Coral, Lilac.
const BRANCH_COLORS = ["#3a83f7", "#3ecf9a", "#f5b53f", "#ff6b5e", "#b08cff"] as const;

type Mark = { x: string; y: string; size: number; color: string };

const MARKS: Mark[] = [
	{ x: "7%", y: "14%", size: 34, color: BRANCH_COLORS[0] },
	{ x: "82%", y: "10%", size: 26, color: BRANCH_COLORS[1] },
	{ x: "88%", y: "24%", size: 40, color: BRANCH_COLORS[2] },
	{ x: "5%", y: "31%", size: 22, color: BRANCH_COLORS[3] },
	{ x: "84%", y: "38%", size: 18, color: BRANCH_COLORS[3] },
	{ x: "90%", y: "57%", size: 28, color: BRANCH_COLORS[1] },
	{ x: "10%", y: "66%", size: 36, color: BRANCH_COLORS[4] },
	{ x: "86%", y: "73%", size: 20, color: BRANCH_COLORS[0] },
	{ x: "76%", y: "85%", size: 44, color: BRANCH_COLORS[4] },
	{ x: "15%", y: "83%", size: 30, color: BRANCH_COLORS[1] },
	{ x: "51%", y: "92%", size: 24, color: BRANCH_COLORS[2] },
	{ x: "28%", y: "94%", size: 20, color: BRANCH_COLORS[0] },
];

export function ForkMarkScatter() {
	return (
		<svg aria-hidden="true" className="absolute inset-0 size-full">
			<defs>
				<symbol id="fork-mark-scatter" viewBox="0 0 20 20">
					<g
						fill="none"
						stroke="currentColor"
						strokeWidth={1.5}
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M4 4v9a2 2 0 0 0 2 2h3M4 8h5" />
						<path d="M11 6h5M11 15h5" />
					</g>
				</symbol>
			</defs>
			{MARKS.map((mark, index) => (
				<use
					key={index}
					href="#fork-mark-scatter"
					x={mark.x}
					y={mark.y}
					width={mark.size}
					height={mark.size}
					color={mark.color}
				/>
			))}
		</svg>
	);
}
