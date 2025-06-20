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
 */
async function bazelGetTargetOutput(
  target: string,
  options: string[] = [],
): Promise<string | undefined> { // Return type can be undefined if user cancels quickpick
  // Workaround for https://github.com/microsoft/vscode/issues/167970
  if (Array.isArray(target)) {
    options = (target[1] || []) as string[];
    target = target[0] as string;
  }
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );
    return undefined;
  }
  const outputPath = await new BazelInfo(
    getDefaultBazelExecutablePath(),
    workspaceInfo.bazelWorkspacePath,
  ).getOne("output_path");
  const outputs = await new BazelCQuery(
    getDefaultBazelExecutablePath(),
    workspaceInfo.bazelWorkspacePath,
  ).queryOutputs(target, options);

  if (outputs.length === 0) {
    // Changed to showInformationMessage as an error might be too disruptive if target genuinely has no outputs.
    vscode.window.showInformationMessage(`Target ${target} has no outputs.`);
    return undefined;
  }
  if (outputs.length === 1) {
    return path.join(outputPath, "..", outputs[0]);
  }
  // Multiple outputs, show quick pick
  const pickedOutput = await vscode.window.showQuickPick(outputs, {
    placeHolder: `Pick an output of ${target}`,
  });
  if (pickedOutput) {
    return path.join(outputPath, "..", pickedOutput);
  }
  return undefined; // User cancelled quick pick
}

// Helper function to find the Bazel package path for a given file
async function findBazelPackagePath(
  filePath: string,
  workspacePath: string,
): Promise<string | undefined> {
  let currentDir = path.dirname(filePath);
  const normalizedWorkspacePath = path.normalize(workspacePath);
  currentDir = path.normalize(currentDir);

  while (currentDir.startsWith(normalizedWorkspacePath) && currentDir !== normalizedWorkspacePath) {
    if (
      fs.existsSync(path.join(currentDir, "BUILD")) ||
      fs.existsSync(path.join(currentDir, "BUILD.bazel"))
    ) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  if (currentDir === normalizedWorkspacePath &&
      (fs.existsSync(path.join(currentDir, "BUILD")) ||
       fs.existsSync(path.join(currentDir, "BUILD.bazel")))
     ) {
    return currentDir;
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

  const packageDir = await findBazelPackagePath(
    currentFilePath,
    workspaceInfo.bazelWorkspacePath,
  );

  if (!packageDir) {
    vscode.window.showInformationMessage(
      `Cannot resolve Bazel target: Could not find BUILD file for ${currentFilePath}. Ensure the file is within a Bazel package.`,
    );
    return undefined;
  }

  const relativePackagePath = path.relative(workspaceInfo.bazelWorkspacePath, packageDir).replace(/\\/g, '/');
  const fileName = path.basename(currentFilePath);
  const fileLabel = `//${relativePackagePath}:${fileName}`;

  const query = `some(kind("(${ruleKindFilterRegex})", same_pkg_direct_rdeps(set(${fileLabel}))))`;

  try {
    const queryResult = await new BazelQuery(
      getDefaultBazelExecutablePath(),
      workspaceInfo.bazelWorkspacePath,
    ).queryTargets(query, {});

    if (queryResult.target && queryResult.target.length > 0) {
      const firstTarget = queryResult.target[0];
      if (firstTarget?.rule?.name) {
        return firstTarget.rule.name;
      }
    }
    return undefined; // No target found matching criteria
  } catch (error: any) { // Added type assertion for error
    if (error.message && error.message.includes(`no such target '${fileLabel}'`)) {
      vscode.window.showInformationMessage(
        `Bazel query note: The file ${fileLabel} is not an explicit target. ` +
        `This may be why no reverse dependencies were found.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Error resolving Bazel target with query "${query}": ${error.message || String(error)}`,
      );
    }
    return undefined;
  } // This is the corrected closing brace for the catch block
} // This is the closing brace for the resolveBazelTargetForCurrentFile function

/**
 * Get the output of \`bazel info\` for the given key.
 */
async function bazelInfo(key: string): Promise<string | undefined> { // Return type can be undefined
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );
    return undefined;
  }
  try {
    return await new BazelInfo(
      getDefaultBazelExecutablePath(),
      workspaceInfo.bazelWorkspacePath,
    ).getOne(key);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error getting Bazel info for key "${key}": ${error.message || String(error)}`);
    return undefined;
  }
}

/**
 * Gets a string-valued argument in a typesafe manner from an object.
 */
function getArgumentValue(
  args: Record<string, any>,
  argName: string,
  commandName: string,
): string | undefined {
  if (argName in args && typeof args[argName] === 'string') {
    return args[argName] as string;
  } else if (argName in args) {
    // Don't throw, just return undefined or message, as per VS Code guidelines for commands
    vscode.window.showErrorMessage(
        `Expected the \`${argName}\` argument for \`${commandName}\` to be a string, but got ${typeof args[argName]}`
    );
    return undefined;
  }
  return undefined;
}

/**
 * Wraps the \`queryQuickPickPackage\` / \`queryQuickPickTargets\` functions
 * so they can be exposed as command variables.
 */
async function wrapQuickPick(
  commandName: string,
  queryQuickPick: (x: QuickPickParams) => Promise<BazelTargetQuickPick[]>,
  args: unknown,
): Promise<string | undefined> {
  const workspaceInfo = await BazelWorkspaceInfo.fromWorkspaceFolders();
  if (!workspaceInfo) {
    vscode.window.showInformationMessage(
      "Please open a Bazel workspace folder to use this command.",
    );
    return undefined;
  }

  let query = "//...";
  let placeHolder = "";

  if (args && typeof args === 'object' && args !== null) {
    const castArgs = args as Record<string, any>; // Type assertion
    query = getArgumentValue(castArgs, "query", commandName) ?? query;
    placeHolder = getArgumentValue(castArgs, "placeHolder", commandName) ?? placeHolder;
  } else if (args) {
      vscode.window.showErrorMessage(
        `Expected the \`args\` for \`${commandName}\` to be an object or undefined, received ${typeof args}`
      );
      return undefined;
  }

  const quickPickItems = await queryQuickPick({ query, workspaceInfo });
  if (!quickPickItems || quickPickItems.length === 0) {
    vscode.window.showInformationMessage("No items found for the quick pick.");
    return undefined;
  }

  const quickPickResult = await vscode.window.showQuickPick(quickPickItems, { // Pass QuickPickItem[]
    canPickMany: false,
    placeHolder,
  });

  if (quickPickResult === undefined) {
    return undefined; // User cancelled
  }

  // Assuming BazelTargetQuickPick has getBazelCommandOptions returning { targets: string[] }
  assert(quickPickResult.getBazelCommandOptions().targets.length === 1);
  return quickPickResult.getBazelCommandOptions().targets[0];
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
      return vscode.commands.registerCommand(commandName, (args: unknown) =>
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
