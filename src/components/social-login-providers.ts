import SiGithub from "@icons-pack/react-simple-icons/icons/SiGithub";

import { GoogleLogo } from "@/components/SocialLoginBrandIcons";

const surface =
  "border-input bg-background text-foreground enabled:hover:bg-accent";
const monochrome =
  "border-transparent bg-zinc-950 text-white enabled:hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:enabled:hover:bg-zinc-200";

export const socialLoginProviders = {
  github: { brandClassName: monochrome, icon: SiGithub, name: "GitHub" },
  google: { brandClassName: surface, icon: GoogleLogo, name: "Google" },
};

export type SocialLoginProvider = keyof typeof socialLoginProviders;
