import {
  findFilenameViolations,
  formatFilenameViolations,
  listGitTrackedFiles,
} from "./filename-policy";

const violations = findFilenameViolations(listGitTrackedFiles());

console.log(formatFilenameViolations(violations));

if (violations.length > 0) {
  process.exitCode = 1;
}
