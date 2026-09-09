import type { LucideIcon } from "lucide-react";
import type { FC, PropsWithChildren } from "react";

export type ReactFC<T> = FC<PropsWithChildren & T>;
export type Size = "xs" | "sm" | "md" | "lg" | "xl";
export interface SelectOption {
  value: string;
  label?: string | undefined;
  emoji?: string | undefined;
  icon?: LucideIcon | undefined;
  closeOnClick?: boolean | undefined;
  disabled?: boolean | undefined;
}
