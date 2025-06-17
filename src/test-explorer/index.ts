import * as vscode from "vscode";
import { BazelFileCoverage, parseLcov } from "./lcov_parser";

let bazelCoverageController: vscode.TestController;
let coverageRunProfile: vscode.TestRunProfile;

export function activateTesting(): vscode.Disposable[] {
  const subscriptions: vscode.Disposable[] = [];

  // Create the test controller
  bazelCoverageController = vscode.tests.createTestController(
    "bazel-coverage-controller",
    "Bazel Coverage Controller",
  );
  subscriptions.push(bazelCoverageController);

  // Create the test run profile
  coverageRunProfile = bazelCoverageController.createRunProfile(
    "Bazel Coverage",
    vscode.TestRunProfileKind.Coverage,
    undefined,
  );
  coverageRunProfile.isDefault = false;
  // `loadDetailedCoverage` is important so that line coverage data is shown.
  coverageRunProfile.loadDetailedCoverage = (_, coverage) =>
    Promise.resolve((coverage as BazelFileCoverage).details);

  return subscriptions;
}

/**
 * Display coverage information from a `.lcov` file.
 *
 * @param description The heading message for test (coverage) run.
 * @param baseFolder The source file entries are relative paths to baseFolder.
 * @param lcov The lcov report data in string.
 */
export async function showLcovCoverage(
  description: string,
  baseFolder: string,
  lcov: string,
) {
  const run = bazelCoverageController.createTestRun(
    new vscode.TestRunRequest(undefined, undefined, coverageRunProfile),
    null,
    false,
  );
  run.appendOutput(description.replaceAll("\n", "\r\n"));
  for (const c of await parseLcov(baseFolder, lcov)) {
    run.addCoverage(c);
  }
  run.end();
}

export { activateBazelTests } from './bazel_test_adapter';
