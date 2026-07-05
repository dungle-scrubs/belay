/** The verdict for the typed/pasted path: nothing entered, entered-but-not-a-path, or ready to launch. */
export type PathValidation = "empty" | "invalid" | "valid";

/**
 * Client-side validation for the New-session picker's typed/pasted path (plan 44.2 M3). A host-side
 * "does this directory exist" validator is not trivially available over the 44.1 contract for this cut,
 * so this is a deliberate CLIENT check: a path is `"valid"` when it is a non-empty ABSOLUTE path -
 * POSIX-absolute (`/…`) or home-relative (`~` / `~/…`, which the supervisor's launcher expands).
 * Anything non-empty that is not absolute (a bare name, a relative path) is `"invalid"`; whitespace or
 * empty is `"empty"`. NOTE: this is intentionally lenient for the happy path; a stricter host-side
 * existence check is a later refinement (a recent root, by contrast, is already a known-valid launch).
 */
export function validatePath(path: string): PathValidation {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  const absolute = trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/");
  return absolute ? "valid" : "invalid";
}
