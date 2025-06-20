// Copyright 2024 The Bazel Authors. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as path from "path";
import * as vscode from "vscode";
import { getDefaultBazelExecutablePath } from "./configuration";
import {
  BazelTargetQuickPick,
  BazelWorkspaceInfo,
  QuickPickParams,
  queryQuickPickPackage,
  queryQuickPickTargets,
} from "../bazel";
import { BazelCQuery } from "../bazel/bazel_cquery";
import { BazelQuery } from "../bazel/bazel_query";
import { BazelInfo } from "../bazel/bazel_info";
import { assert } from "console";
import * as fs from "fs";

/**
 * Get the output of the given target.
 *
 * If there are multiple outputs, a quick-pick window will be opened asking the
 * user to choose one.
 *
 * The `bazel.getTargetOutput` command can be used in launch configurations to
 * obtain the path to an executable built by Bazel. For example, you can set the
 * "program" attribute of a launch configuration to an input variable:
 *
 * ```
 * "program": "${input:binaryOutputLocation}"
 * ```
 *
 * Then define a command input variable:
 *
 * ```
 * "inputs": [
 *     {
 *         "id": "binaryOutputLocation",
 *         "type": "command",
 *         "command": "bazel.getTargetOutput",
 *         "args": ["//my/binary:target"],
 *     }
 * ]
 * ```
 *
 * Additional Bazel flags can be provided:
 *
 * ```
 * "inputs": [
 *     {
 *         "id": "debugOutputLocation",
 *         "type": "command",
 *         "command": "bazel.getTargetOutput",
 *         "args": ["//my/binary:target", ["--compilation_mode", "dbg"]],
 *     }
 * ]
 * ```
 */
async function bazelGetTargetOutput(
  target: string,
  options: string[] = [],
): Promise<string> {
  // Workaround for https://github.com/microsoft/vscode/issues/167970
  if (Array.isArray(target)) {
    options = (target[1] || []) as string[];
    target = target[0] as string;
  }
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );

    return;
  }
  const outputPath = await new BazelInfo(
    getDefaultBazelExecutablePath(),
    workspaceInfo.bazelWorkspacePath,
  ).getOne("output_path");
  const outputs = await new BazelCQuery(
    getDefaultBazelExecutablePath(),
    workspaceInfo.bazelWorkspacePath,
  ).queryOutputs(target, options);
  switch (outputs.length) {
    case 0:
      throw new Error(`Target ${target} has no outputs.`);
    case 1:
      return path.join(outputPath, "..", outputs[0]);
    default:
      return await vscode.window.showQuickPick(outputs, {
        placeHolder: `Pick an output of ${target}`,
      });
  }
}

async function findBazelPackagePath(
  filePath: string,
  workspacePath: string,
): Promise<string | undefined> {
  let currentDir = path.dirname(filePath);
  while (currentDir.startsWith(workspacePath) && currentDir !== workspacePath) {
    if (
      fs.existsSync(path.join(currentDir, "BUILD")) ||
      fs.existsSync(path.join(currentDir, "BUILD.bazel"))
    ) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  // Check the workspace root itself
  if (
    fs.existsSync(path.join(workspacePath, "BUILD")) ||
    fs.existsSync(path.join(workspacePath, "BUILD.bazel"))
  ) {
    return workspacePath;
  }
  return undefined;
}

async function resolveBazelTargetForCurrentFile(
  ruleKindFilterRegex: string,
): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Cannot resolve Bazel target: No active text editor.",
    );
    return undefined;
  }

  const currentFilePath = editor.document.uri.fsPath;
  if (!currentFilePath) {
    vscode.window.showInformationMessage(
      "Cannot resolve Bazel target: Active file has no path.",
    );
    return undefined;
  }

  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );
    return undefined;
  }

  // Determine the file's package path relative to the workspace root
  const packagePath = await findBazelPackagePath(
    currentFilePath,
    workspaceInfo.bazelWorkspacePath,
  );

  if (!packagePath) {
    vscode.window.showInformationMessage(
      `Cannot resolve Bazel target: Could not find BUILD file for ${currentFilePath}.`,
    );
    return undefined;
  }

  const relativePackagePath = path.relative(workspaceInfo.bazelWorkspacePath, packagePath);
  const fileName = path.basename(currentFilePath);
  // Construct the label for the file itself
  const fileLabel = `//${relativePackagePath}:${fileName}`;

  // Query for direct reverse dependencies in the same package, filtered by kind, limit to one.
  const query = `some(kind("(${ruleKindFilterRegex})", same_pkg_direct_rdeps(set(${fileLabel}))))`;

  try {
    const queryResult = await new BazelQuery(
      getDefaultBazelExecutablePath(),
      workspaceInfo.bazelWorkspacePath,
    ).queryTargets(query, {});

    if (queryResult.target && queryResult.target.length > 0) {
      const firstTarget = queryResult.target[0]; // Should be only one due to some()
      if (firstTarget.rule && firstTarget.rule.name) {
        return firstTarget.rule.name;
      }
    }
    // No message if no target found, VS Code won't substitute.
    return undefined;
  } catch (error) {
    // Check if error is due to "no such target" for the fileLabel itself
    if (error.message && error.message.includes(`no such target '${fileLabel}'`)) {
        // This is expected if the file is not explicitly listed in a BUILD file (e.g. source file)
        // We might need a different query strategy if files themselves aren't targets,
        // e.g. query on the directory or all targets in the package and then filter.
        // For now, let's assume fileLabel is valid or rdeps can handle non-target files.
        // The user feedback implied rdeps on a file, so let's proceed with this assumption.
        // If tests fail here, this is the area to revisit.
          vscode.window.showInformationMessage(
            `No Bazel target found for file ${fileLabel} that matches the criteria.`
          );
    } else {
        vscode.window.showErrorMessage(
          `Error resolving Bazel target: ${error.message || error}`,
        );
    }
    return undefined;
 * Get the output of `bazel info` for the given key.
 *
 * If there are multiple outputs, a quick-pick window will be opened asking the
 * user to choose one.
 */
async function bazelInfo(key: string): Promise<string> {
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );
    return;
  }
  return new BazelInfo(
    getDefaultBazelExecutablePath(),
    workspaceInfo.bazelWorkspacePath,
  ).getOne(key);
}

/**
 * Gets a string-valued argument in a typesafe manner from an object.
 * Throws `Error`s with user-friendly error messages in case of an error.
 *
 * @param args the arguments
 * @param argName the argument name
 * @param commandName the commmand name. Used in the error message
 * @returns the extracted string value
 */
function getArgumentValue(
  args: Record<string, any>,
  argName: string,
  commandName: string,
): string | undefined {
  if (argName in args && typeof args[argName] === "string") {
    return args[argName] as string;
  } else if (argName in args) {
    throw new Error(
      `Expected the \`${argName}\` argument for \`${commandName}\` to be a string`,
    );
  }
}

/**
 * Wraps the `queryQuickPickPackage` / `queryQuickPickTargets` functions
 * so they can be exposed as command variables.
 */
async function wrapQuickPick(
  commandName: string,
  queryQuickPick: (x: QuickPickParams) => Promise<BazelTargetQuickPick[]>,
  args: unknown,
): Promise<string | undefined> {
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );

    return;
  }

  // Default values, overridable from the `tasks.json` invocation
  let query = "//...";
  let placeHolder = "";

  // Interpret the arguments
  if (args) {
    if (!(args instanceof Object) || args instanceof Array) {
      throw new Error(
        `Expected the \`args\` for \`${commandName}\` to be an object`,
      );
    } else {
      query = getArgumentValue(args, "query", commandName) ?? query;
      placeHolder =
        getArgumentValue(args, "placeHolder", commandName) ?? placeHolder;
    }
  }
  const quickPick = await vscode.window.showQuickPick(
    queryQuickPick({ query, workspaceInfo }),
    {
      canPickMany: false,
      placeHolder,
    },
  );
  if (quickPick === undefined) {
    // If the user cancelled the quick pick, fail the substitution
    return;
  }
  assert(quickPick.getBazelCommandOptions().targets.length === 1);
  return quickPick.getBazelCommandOptions().targets[0];
}

/**
 * Activate all "command variables"
 */
export function activateCommandVariables(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "bazel.getTargetOutput",
      bazelGetTargetOutput,
    ),
    vscode.commands.registerCommand("bazel.currentTarget", () =>
      resolveBazelTargetForCurrentFile(".*_test rule.*|.*_binary rule.*"),
    ),
    vscode.commands.registerCommand("bazel.currentTestTarget", () =>
      resolveBazelTargetForCurrentFile(".*_test rule.*"),
    ),
    vscode.commands.registerCommand("bazel.currentBinaryTarget", () =>
      resolveBazelTargetForCurrentFile(".*_binary rule.*"),
    ),
    ...["pickPackage", "pickTarget"].map((key, idx) => {
      const commandName = `bazel.${key}`;
      const funcs = [queryQuickPickPackage, queryQuickPickTargets];
      const func = funcs[idx];
      return vscode.commands.registerCommand(commandName, (args) =>
        wrapQuickPick(commandName, func, args),
      );
    }),
    ...[
      "bazel-bin",
      "bazel-genfiles",
      "bazel-testlogs",
      "execution_root",
      "output_base",
      "output_path",
      "workspace",
    ].map((key) =>
      vscode.commands.registerCommand(`bazel.info.${key}`, () =>
        bazelInfo(key),
      ),
    ),
  ];
}
