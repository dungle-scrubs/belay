import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// SMUI adds custom font-size utilities (text-label/text-ui/text-heading/...).
// tailwind-merge treats them as colors and would drop them next to text-* color
// classes, so register them as their own font-size group. See smui skill.md.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-label", "text-ui", "text-heading", "text-stat", "text-hero"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
