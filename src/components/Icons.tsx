import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			{children}
		</svg>
	);
}

const stroke = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.3,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

export function ComposeIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M8.167 2.501a.665.665 0 0 1 0 1.33H5.834a2 2 0 0 0-2.002 2.002v8.333c0 1.106.896 2.002 2.002 2.002h8.333a2 2 0 0 0 2.002-2.002v-2.333a.665.665 0 0 1 1.33 0v2.333a3.33 3.33 0 0 1-3.332 3.332H5.834a3.33 3.33 0 0 1-3.332-3.332V5.833a3.333 3.333 0 0 1 3.332-3.332z" />
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M13.427 3.104a2.451 2.451 0 0 1 3.46 3.472l-5.163 5.203a3.13 3.13 0 0 1-1.55.853l-2.386.524a.815.815 0 0 1-.97-.971l.525-2.38c.13-.59.429-1.131.86-1.556zm2.512.953a1.12 1.12 0 0 0-1.579-.006L9.136 9.197c-.247.244-.42.554-.495.894l-.351 1.594 1.598-.352c.338-.074.648-.245.892-.49l5.162-5.204a1.12 1.12 0 0 0-.003-1.582"
			/>
		</Svg>
	);
}

export function SidebarIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M14.5 2.877a3.665 3.665 0 0 1 3.665 3.665v6.917a3.665 3.665 0 0 1-3.665 3.665h-9a3.665 3.665 0 0 1-3.665-3.665V6.542A3.665 3.665 0 0 1 5.5 2.877zM8.165 15.794H14.5a2.335 2.335 0 0 0 2.335-2.335V6.542A2.335 2.335 0 0 0 14.5 4.207H8.165zM5.5 4.207a2.335 2.335 0 0 0-2.335 2.335v6.917A2.335 2.335 0 0 0 5.5 15.794h1.335V4.207z"
			/>
		</Svg>
	);
}

export function SendIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M8.869 3.951a1.6 1.6 0 0 1 2.262 0l4.439 4.438a1.1 1.1 0 0 1-1.556 1.555L11.1 7.03v8.595a1.1 1.1 0 1 1-2.2 0V7.029L5.987 9.944A1.1 1.1 0 1 1 4.43 8.39z" />
		</Svg>
	);
}

export function StopIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<rect x="5" y="5" width="10" height="10" rx="2" />
		</Svg>
	);
}

export function RegenerateIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M3.502 16.666v-3.333c0-.367.298-.665.665-.665H7.5l.134.014a.665.665 0 0 1 0 1.303l-.134.013H5.475A6.12 6.12 0 0 0 10 16.001c3.06 0 5.586-2.29 5.955-5.25l.03-.131a.665.665 0 0 1 1.29.295l-.05.337A7.33 7.33 0 0 1 10 17.332a7.46 7.46 0 0 1-5.168-2.085v1.42a.665.665 0 0 1-1.33 0m.543-7.417a.665.665 0 0 1-1.32-.165zM10 2.67c1.994 0 3.837.797 5.178 2.093V3.333a.665.665 0 0 1 1.33 0v3.333a.665.665 0 0 1-.665.665H12.51a.665.665 0 0 1 0-1.33h2.015A6.12 6.12 0 0 0 10 3.998 6.003 6.003 0 0 0 4.045 9.25l-.66-.083-.66-.082A7.333 7.333 0 0 1 10 2.668" />
		</Svg>
	);
}

export function MoreIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M4.167 8.501a1.499 1.499 0 1 1 0 2.998 1.499 1.499 0 0 1 0-2.998M10 8.501a1.499 1.499 0 1 1 0 2.998 1.499 1.499 0 0 1 0-2.998M15.834 8.501a1.5 1.5 0 1 1-.001 2.999 1.5 1.5 0 0 1 0-2.999" />
		</Svg>
	);
}

export function CopyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M15.1006 1.78516C16.793 1.78556 18.165 3.15808 18.165 4.85059V10.8838C18.1649 12.5762 16.7929 13.9478 15.1006 13.9482H13.998V15.0508C13.9976 16.7431 12.626 18.1151 10.9336 18.1152H4.90039C3.20789 18.1152 1.83537 16.7432 1.83496 15.0508V9.01758C1.83496 7.32482 3.20764 5.95215 4.90039 5.95215H6.00195V4.85059C6.00195 3.15783 7.37463 1.78516 9.06738 1.78516H15.1006ZM4.90039 7.28223C3.94218 7.28223 3.16504 8.05936 3.16504 9.01758V15.0508C3.16544 16.0087 3.94243 16.7852 4.90039 16.7852H10.9336C11.8914 16.785 12.6676 16.0086 12.668 15.0508V9.01758C12.668 8.05945 11.8917 7.28237 10.9336 7.28223H4.90039ZM9.06738 3.11523C8.10917 3.11523 7.33203 3.89237 7.33203 4.85059V5.95215H10.9336C12.6262 5.95229 13.998 7.32491 13.998 9.01758V12.6182H15.1006C16.0584 12.6178 16.835 11.8415 16.835 10.8838V4.85059C16.835 3.89263 16.0585 3.11563 15.1006 3.11523H9.06738Z"
			/>
		</Svg>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path {...stroke} strokeWidth={1.5} d="M4 10.5l4 4 8-8.5" />
		</Svg>
	);
}

const thumbPath =
	"M6.5 8.5l3.3-5.1a1.35 1.35 0 0 1 2.45.9L11.7 7.5h3.5a1.9 1.9 0 0 1 1.87 2.25l-.95 4.6A1.9 1.9 0 0 1 14.25 15.9H6.5zM6.5 8.5H4.3a1.3 1.3 0 0 0-1.3 1.3v4.8a1.3 1.3 0 0 0 1.3 1.3h2.2";

export function ThumbsUpIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path {...stroke} d={thumbPath} />
		</Svg>
	);
}

export function ThumbsDownIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path {...stroke} d={thumbPath} transform="rotate(180 10 10)" />
		</Svg>
	);
}

export function PencilIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path
				{...stroke}
				d="M13.3 3.2a1.8 1.8 0 0 1 2.5 2.5l-8.6 8.6-3.4.9.9-3.4zM11.8 4.7l2.5 2.5"
			/>
		</Svg>
	);
}

export function TrashIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path
				{...stroke}
				d="M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.6 10a1.5 1.5 0 0 0 1.5 1.4h4.8a1.5 1.5 0 0 0 1.5-1.4l.6-10M8.3 8.5v5.5M11.7 8.5v5.5"
			/>
		</Svg>
	);
}

export function CloseIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path {...stroke} strokeWidth={1.5} d="M5 5l10 10M15 5L5 15" />
		</Svg>
	);
}

export function LogOutIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path
				{...stroke}
				d="M8.5 3.5H5.2A1.7 1.7 0 0 0 3.5 5.2v9.6a1.7 1.7 0 0 0 1.7 1.7h3.3M12.5 13.5 16 10l-3.5-3.5M16 10H7.5"
			/>
		</Svg>
	);
}

export function GitHubIcon(props: IconProps) {
	return (
		<Svg viewBox="0 0 16 16" {...props}>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</Svg>
	);
}

export function PasskeyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="7" cy="10" r="3.4" {...stroke} />
			<path {...stroke} d="M10.4 10h7.1M14.6 10v2.7M12.2 10v2" />
		</Svg>
	);
}
