import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as path from 'path'; // Ensure path is imported if not already
import { BazelQuery } from '../bazel/bazel_query';
import { BazelWorkspaceInfo } from '../bazel/bazel_workspace_info';
import { BazelInfo } from '../bazel/bazel_info'; // Import BazelInfo
import { blaze_query } from '../protos';

let bazelTestController: vscode.TestController;
const testItemData = new WeakMap<vscode.TestItem, { bazelLabel: string, kind: string, package: string }>();

function getBazelWorkspaceInfo(context: vscode.ExtensionContext): BazelWorkspaceInfo | undefined {
  const workspaceInfo = BazelWorkspaceInfo.fromContext(context);
  if (!workspaceInfo?.bazelExecutablePath) {
    vscode.window.showErrorMessage("Bazel executable path not found or workspace info is unavailable. Ensure Bazel is configured.");
    return undefined;
  }
  return workspaceInfo;
}

async function discoverAllTestsInWorkspace(
  controller: vscode.TestController,
  workspaceInfo: BazelWorkspaceInfo,
  context: vscode.ExtensionContext // context might be used for showing progress, etc.
): Promise<void> {
  vscode.window.showInformationMessage("Bazel test discovery started...");
  const bazelQuery = new BazelQuery(workspaceInfo.bazelExecutablePath, workspaceInfo.workspaceFolder.uri.fsPath, {});

  try {
    const queryResult = await bazelQuery.queryTargets('kind(".*_test rule", //...)');
    const packages = new Map<string, vscode.TestItem>();

    if (queryResult && queryResult.target) {
      for (const target of queryResult.target) {
        if (target.type === blaze_query.Target.Type.RULE && target.rule) {
          const rule = target.rule;
          const bazelLabel = rule.name; // e.g., //foo:bar_test
          const kind = rule.ruleType;    // e.g., cc_test

          if (!bazelLabel || !kind) {
            console.warn("Skipping target with missing label or kind:", target);
            continue;
          }

          const packagePath = bazelLabel.substring(0, bazelLabel.lastIndexOf(':')); // e.g., //foo
          const ruleNameOnly = bazelLabel.substring(bazelLabel.lastIndexOf(':') + 1); // e.g., bar_test
          const packageDir = packagePath.startsWith("//") ? packagePath.substring(2) : packagePath; // e.g., foo

          let packageItem = packages.get(packagePath);
          if (!packageItem) {
            const packageDisplayName = path.basename(packageDir) || path.dirname(packageDir); // Use directory name for package
            const packageUri = vscode.Uri.file(path.join(workspaceInfo.workspaceFolder.uri.fsPath, packageDir));
            packageItem = controller.createTestItem(packagePath, packageDisplayName, packageUri);
            packageItem.canResolveChildren = false; // Packages themselves don't resolve children further in this model
            controller.items.add(packageItem);
            packages.set(packagePath, packageItem);
          }

          let testRuleItemUri = packageItem.uri!; // Default to package URI
          let testRuleItemRange: vscode.Range | undefined;

          if (rule.location) {
            // Location format: /path/to/workspace/foo/BUILD:12:1
            const parts = rule.location.split(':');
            if (parts.length >= 2) {
              const filePath = parts[0];
              const lineNumber = parseInt(parts[1], 10);
              if (!isNaN(lineNumber) && filePath.startsWith(workspaceInfo.workspaceFolder.uri.fsPath)) {
                testRuleItemUri = vscode.Uri.file(filePath);
                // VS Code lines are 0-indexed
                testRuleItemRange = new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, 0));
              } else {
                 // Fallback for locations outside workspace (should not happen for BUILD files) or bad parse
                console.warn(`Could not parse location for ${bazelLabel}: ${rule.location}. Using package URI.`);
                // Use the BUILD file in the package directory as a fallback URI if location is odd
                const buildFilePath = path.join(workspaceInfo.workspaceFolder.uri.fsPath, packageDir, 'BUILD'); // Or BUILD.bazel
                try {
                    // Check if BUILD file exists, otherwise use package URI
                    await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath));
                    testRuleItemUri = vscode.Uri.file(buildFilePath);
                } catch {
                    // BUILD file doesn't exist, stick to packageItem.uri
                }
              }
            }
          } else {
             // Fallback if no location: use the BUILD file in the package directory
             const buildFilePath = path.join(workspaceInfo.workspaceFolder.uri.fsPath, packageDir, 'BUILD'); // Or BUILD.bazel
             try {
                await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath));
                testRuleItemUri = vscode.Uri.file(buildFilePath);
             } catch {
                // BUILD file doesn't exist, stick to packageItem.uri
             }
          }

          const testRuleItem = controller.createTestItem(bazelLabel, ruleNameOnly, testRuleItemUri);
          if (testRuleItemRange) {
            testRuleItem.range = testRuleItemRange;
          }
          testRuleItem.canResolveChildren = false; // Test rules do not have children
          testItemData.set(testRuleItem, { bazelLabel, kind, package: packagePath });
          packageItem.children.add(testRuleItem);
        }
      }
    }
    vscode.window.showInformationMessage(`Bazel test discovery finished. Found ${queryResult.target?.length || 0} total targets.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error during Bazel test discovery: ${error}`);
    console.error("Bazel query failed:", error);
  }
}

export function activateBazelTests(context: vscode.ExtensionContext): void {
  bazelTestController = vscode.tests.createTestController(
    'bazelTests', // Unique ID for the controller
    'Bazel Tests' // Human-readable label
  );
  context.subscriptions.push(bazelTestController);

  bazelTestController.resolveHandler = async (item?: vscode.TestItem) => {
    if (!item) {
      // Initial load: discover all tests.
      const workspaceInfo = getBazelWorkspaceInfo(context);
      if (workspaceInfo) {
        await discoverAllTestsInWorkspace(bazelTestController, workspaceInfo, context);
      } else {
        vscode.window.showErrorMessage("Failed to get Bazel workspace info. Test discovery aborted.");
      }
    } else {
      // TODO: Handle user expanding a TestItem.
      // If item is a package (packageItem.canResolveChildren = true),
      // then discover tests within that package.
      // For now, this is a no-op as discoverAllTestsInWorkspace loads everything.
    }
  };


  const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const run = bazelTestController.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    const currentWorkspaceInfo = getBazelWorkspaceInfo(context);
    if (!currentWorkspaceInfo) {
      vscode.window.showErrorMessage("Cannot run tests: Bazel workspace information is not available.");
      run.end();
      return;
    }

    // Determine tests to run
    if (request.include) {
      request.include.forEach(item => queue.push(item));
    } else {
      bazelTestController.items.forEach(item => { // These are package items
        item.children.forEach(childItem => queue.push(childItem)); // These are test rule items
      });
    }

    // Filter out excluded tests
    const testsToRun = queue.filter(testItem => !request.exclude?.includes(testItem));

    for (const testItem of testsToRun) {
      if (token.isCancellationRequested) {
        run.skipped(testItem);
        continue;
      }

      run.started(testItem);
      const testData = testItemData.get(testItem);
      if (!testData) {
        run.errored(testItem, [{ message: "Test data not found for this item." }]);
        continue;
      }

      const { bazelLabel } = testData;
      const startTime = Date.now();

      run.appendOutput(`Executing: bazel test ${bazelLabel}\r\n`);

      const bazelExecutablePath = currentWorkspaceInfo.bazelExecutablePath;
      const startupOptions = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('startupOptions') || [];
      const commandArgs = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('commandArgs') || [];

      const args = [
        ...startupOptions,
        'test',
        ...commandArgs,
        '--test_output=streamed', // Essential for seeing live test output
        '--verbose_failures',     // More detail on failures
        // '--color=no',          // Consider if output parsing becomes an issue
        bazelLabel,
      ];

      await new Promise<void>((resolve) => {
        const child = child_process.spawn(bazelExecutablePath, args, { cwd: currentWorkspaceInfo.workspaceFolder.uri.fsPath });
        let combinedOutput = "";

        child.stdout.on('data', (data) => {
          const output = data.toString().replace(/\r?\n/g, '\r\n');
          run.appendOutput(output, undefined, testItem);
          combinedOutput += output;
        });

        child.stderr.on('data', (data) => {
          const output = data.toString().replace(/\r?\n/g, '\r\n');
          run.appendOutput(output, undefined, testItem);
          combinedOutput += output;
        });

        child.on('error', (err) => {
          const duration = Date.now() - startTime;
          run.errored(testItem, [{ message: `Failed to start Bazel process: ${err.message}.\nOutput:\n${combinedOutput}` }], duration);
          resolve();
        });

        child.on('close', async (code) => { // Make this callback async
          const duration = Date.now() - startTime;

          if (code === 0 || code === 3) {
            try {
              const bazelInfo = new BazelInfo(bazelExecutablePath, currentWorkspaceInfo.workspaceFolder.uri.fsPath);
              const testlogsPath = await bazelInfo.getOne('bazel-testlogs');

              if (testlogsPath) {
                // bazelLabel is like //foo/bar:my_test or @repo//foo/bar:my_test
                let effectiveLabel = bazelLabel;
                if (effectiveLabel.startsWith('@')) {
                  // For external repos, the path in testlogs might not have the @repo part,
                  // or it might be under a different structure. This might need refinement.
                  // For now, let's assume it might be flattened or needs specific handling.
                  // A common pattern is 'external/repo_name/package/target'.
                  // This is a complex area, so a simple approach first:
                  effectiveLabel = effectiveLabel.substring(effectiveLabel.indexOf('//') + 2);
                   console.warn(`External repo label ${bazelLabel} - test.xml path construction might be inaccurate.`);
                } else if (effectiveLabel.startsWith('//')) {
                  effectiveLabel = effectiveLabel.substring(2);
                }

                const parts = effectiveLabel.split(':');
                if (parts.length === 2) {
                  const packagePath = parts[0];
                  const targetName = parts[1];
                  const xmlPath = path.join(testlogsPath, packagePath, targetName, 'test.xml');
                  console.log(`Expected test.xml path: ${xmlPath}`);
                  run.appendOutput(`Expected test.xml path: ${xmlPath}\r\n`);
                } else {
                  console.warn(`Could not parse package and target from label: ${bazelLabel}`);
                  run.appendOutput(`Could not parse package/target from label: ${bazelLabel} to find test.xml\r\n`);
                }
              } else {
                console.warn('bazel-testlogs path not found.');
                run.appendOutput('Warning: bazel-testlogs path not found, cannot locate test.xml.\r\n');
              }
            } catch (err: any) {
              console.error(`Error getting bazel-testlogs: ${err.message}`);
              run.appendOutput(`Error getting bazel-testlogs: ${err.message}\r\n`);
            }
          }

          if (token.isCancellationRequested) {
            run.skipped(testItem);
          } else {
            switch (code) {
              case 0: // All tests passed
                run.passed(testItem, duration);
                break;
              case 1: // Build failed / Other error
                run.errored(testItem, [{ message: `Bazel command failed with exit code ${code}. Check output for build errors or other issues.\nOutput:\n${combinedOutput}` }], duration);
                break;
              case 3: // Tests failed
                run.failed(testItem, [{ message: 'Tests failed. See output for details. XML might be available.' }], duration);
                break;
              case 4: // No tests found
                run.skipped(testItem);
                run.appendOutput(`No tests found for ${bazelLabel}\r\n`, undefined, testItem);
                break;
              default: // Other non-zero codes
                run.errored(testItem, [{ message: `Bazel test command failed with exit code ${code}.\nOutput:\n${combinedOutput}` }], duration);
                break;
            }
          }
          resolve();
        });
      });
    }
    run.end();
  };

  // Create and register the Test Run Profile
  // The last argument `true` makes this the default run profile.
  bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true);
  // TODO: Implement Debug Profile

  // File System Watcher for BUILD and .bzl files
  const initialWorkspaceInfo = getBazelWorkspaceInfo(context); // Renamed to avoid conflict with currentWorkspaceInfo
  if (initialWorkspaceInfo) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(initialWorkspaceInfo.workspaceFolder, '**/{BUILD,BUILD.bazel,*.bzl}')
    );
    context.subscriptions.push(watcher);

    const fullRefresh = async (uri: vscode.Uri) => {
      vscode.window.showInformationMessage(`File change detected (${uri.fsPath}), triggering full test refresh.`);
      const currentWorkspaceInfo = getBazelWorkspaceInfo(context); // Re-fetch workspace info
      if (currentWorkspaceInfo) {
        bazelTestController.items.clear(); // Clear previous items before rediscovery
        await discoverAllTestsInWorkspace(bazelTestController, currentWorkspaceInfo, context);
      } else {
        vscode.window.showWarningMessage("Workspace info became unavailable. Cannot refresh tests after file change.");
      }
    };

    watcher.onDidChange(async (uri) => {
      // If a .bzl file changes, or for simplicity for now, any BUILD file change, do a full refresh.
      // More granular updates for BUILD file changes can be a future refinement.
      await fullRefresh(uri);
    });

    watcher.onDidCreate(async (uri) => {
      // Similar to onDidChange, a new BUILD file or .bzl file might affect multiple things.
      await fullRefresh(uri);
    });

    watcher.onDidDelete(async (uri) => {
      const fileName = path.basename(uri.fsPath);
      if (fileName === 'BUILD' || fileName === 'BUILD.bazel') {
        // Attempt to determine package path from URI
        // Relative path from workspace root to the directory of the BUILD file
        const packageDirRelativePath = path.dirname(vscode.workspace.asRelativePath(uri, false));
        // Convert to Bazel package path format (e.g., //path/to/package)
        // Replace backslashes for Windows, ensure leading //
        const bazelPackagePath = `//${packageDirRelativePath.replace(/\\/g, '/')}`;

        vscode.window.showInformationMessage(`BUILD file deleted (${uri.fsPath}), removing package ${bazelPackagePath}.`);

        // Check if this package exists at the top level of test items
        const packageItem = bazelTestController.items.get(bazelPackagePath);
        if (packageItem) {
          bazelTestController.items.delete(bazelPackagePath);
          // Also clear from testItemData if we were storing package data there (currently not)
        } else {
          // If not found directly, it might be safer to do a full refresh,
          // as the deleted BUILD file could affect tests in other packages (e.g. sub-packages not explicitly listed)
          // or the package naming convention might differ.
          vscode.window.showWarningMessage(`Package ${bazelPackagePath} not found directly, consider full refresh if issues persist.`);
          // Optionally, trigger fullRefresh(uri) here if granular delete is too complex or error-prone.
        }
      } else if (uri.fsPath.endsWith(".bzl")) {
        // Deletion of a .bzl file requires a full refresh.
        await fullRefresh(uri);
      }
    });
  } else {
    vscode.window.showWarningMessage("Bazel workspace info not available. File watchers for test discovery not activated.");
  }
}

export function getBazelTestController(): vscode.TestController {
  if (!bazelTestController) {
    throw new Error('Bazel Test Controller not activated');
  }
  return bazelTestController;
}
