import {
  findFilenameViolations,
  formatFilenameViolations,
  listGitTrackedFiles,
} from "./filename-policy";
import { findResidualNameViolations, formatResidualNameViolations } from "./residual-name-policy";

const paths = listGitTrackedFiles();
const filenameViolations = findFilenameViolations(paths);
const residualNameViolations = findResidualNameViolations(paths);

console.log(formatFilenameViolations(filenameViolations));
console.log(formatResidualNameViolations(residualNameViolations));

if (filenameViolations.length > 0 || residualNameViolations.length > 0) {
  process.exitCode = 1;
}
