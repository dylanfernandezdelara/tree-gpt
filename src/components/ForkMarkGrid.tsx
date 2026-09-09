/**
 * The login cover: the Fork tree mark (same geometry as `TreeIcon`) tiled in a
 * brick-staggered grid over an ink field. Five branch colors cycle so no two
 * touching tiles share one; still by design, so there is nothing to reduce for
 * prefers-reduced-motion.
 *
 * `cover` is the tall desktop panel. `strip` is a short, wide band for phone
 * widths: its viewBox is much wider than any sub-`lg` strip, so `slice` scales
 * it to the band's height and always shows about four dense rows instead of a
 * handful of oversized tiles.
 */

const TILE = 80;
const MARK = 50;
const MARK_INSET = (TILE - MARK) / 2;

// Trunk (brand blue), Leaf, Amber, Coral, Lilac.
const BRANCH_COLORS = ["#3a83f7", "#3ecf9a", "#f5b53f", "#ff6b5e", "#b08cff"] as const;

export type ForkMarkGridVariant = "cover" | "strip";

const LAYOUTS: Record<ForkMarkGridVariant, { cols: number; rows: number }> = {
	cover: { cols: 11, rows: 13 },
	strip: { cols: 31, rows: 4 },
};

type Tile = { key: string; x: number; y: number; color: string };

function buildTiles(cols: number, rows: number): Tile[] {
	const tiles: Tile[] = [];
	for (let row = 0; row < rows; row++) {
		const shift = row % 2 === 1 ? -TILE / 2 : 0;
		for (let col = 0; col < cols; col++) {
			// +1 across a row, +2 down a column: staggered neighbours land on
			// offsets 1, 2 or 3 mod 5, never 0.
			const color = BRANCH_COLORS[(col + row * 2) % BRANCH_COLORS.length];
			tiles.push({
				key: `${row}-${col}`,
				x: col * TILE + shift + MARK_INSET,
				y: row * TILE + MARK_INSET,
				color,
			});
		}
	}
	return tiles;
}

const TILES: Record<ForkMarkGridVariant, Tile[]> = {
	cover: buildTiles(LAYOUTS.cover.cols, LAYOUTS.cover.rows),
	strip: buildTiles(LAYOUTS.strip.cols, LAYOUTS.strip.rows),
};

export function ForkMarkGrid({ variant = "cover" }: { variant?: ForkMarkGridVariant }) {
	const { cols, rows } = LAYOUTS[variant];
	// Both variants can be in the DOM at once (toggled by breakpoint), so the
	// symbol id must be unique per variant.
	const symbolId = `fork-mark-${variant}`;
	return (
		<svg
			aria-hidden="true"
			className="absolute inset-0 size-full"
			viewBox={`0 0 ${TILE * (cols - 1)} ${TILE * rows - TILE / 2}`}
			preserveAspectRatio="xMidYMid slice"
		>
			<defs>
				<symbol id={symbolId} viewBox="0 0 20 20">
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
			<rect width="100%" height="100%" fill="#0c1626" />
			{TILES[variant].map((tile) => (
				<use
					key={tile.key}
					href={`#${symbolId}`}
					x={tile.x}
					y={tile.y}
					width={MARK}
					height={MARK}
					color={tile.color}
				/>
			))}
		</svg>
	);
}
