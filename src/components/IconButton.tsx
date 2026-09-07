import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string;
	children: ReactNode;
};

export function IconButton({ label, className, children, ...rest }: Props) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={["icon-button", className].filter(Boolean).join(" ")}
			{...rest}
		>
			{children}
		</button>
	);
}
