import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as xml2js from 'xml2js';
import { BazelQuery } from '../bazel/bazel_query';
import { BazelWorkspaceInfo } from '../bazel/bazel_workspace_info';
import { BazelInfo } from '../bazel/bazel_info';
import { blaze_query } from '../protos';

let moduleBazelTestController: vscode.TestController;
export const testItemData = new WeakMap<vscode.TestItem, { bazelLabel: string, kind: string, package: string }>();
// Module-scoped map to keep track of package TestItems for efficient updates.
export let packagesMap = new Map<string, vscode.TestItem>(); // Export for test access

export interface IBazelTestAdapterWorkspaceInfo {
  bazelWorkspace: BazelWorkspaceInfo;
  bazelExecutablePath: string;
  workspaceFolder: vscode.WorkspaceFolder;
}

// Interface for file system operations needed by runHandler
export interface TestExplorerFs {
    readFile(uri: vscode.Uri): Thenable<Uint8Array>;
    // stat(uri: vscode.Uri): Thenable<vscode.FileStat>; // If stat is also needed
}

// Helper function to log test output to both console and VS Code Test Output
function logTestOutput(run: vscode.TestRun, message: string, item?: vscode.TestItem) {
  console.log(message); // Log to console for debugging tests
  const sanitizedMessage = message.replace(/\r?\n/g, '\r\n'); // Ensure consistent line endings for VS Code
  run.appendOutput(`${sanitizedMessage}\r\n`, undefined, item);
}

export function getBazelTestAdapterWorkspaceInfo(context: vscode.ExtensionContext): IBazelTestAdapterWorkspaceInfo | undefined { // Exported for testing
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return undefined;
  }

  const workspaceFolder = workspaceFolders[0];
  const bazelWorkspace = BazelWorkspaceInfo.fromWorkspaceFolder(workspaceFolder);

  if (!bazelWorkspace) {
    vscode.window.showErrorMessage(`Folder '${workspaceFolder.name}' is not a Bazel workspace.`);
    return undefined;
  }

  const bazelConfig = vscode.workspace.getConfiguration("bazel");
  const bazelExecutablePath = bazelConfig.get<string>("executable") || "bazel";

  return { bazelWorkspace, bazelExecutablePath, workspaceFolder };
}

function getOrCreatePackageTestItemRecursive(
    fullPackagePath: string,
    controller: vscode.TestController,
    adapterInfo: IBazelTestAdapterWorkspaceInfo,
    packagesMap: Map<string, vscode.TestItem>
): vscode.TestItem {
    if (!fullPackagePath || fullPackagePath === '//') {
        throw new Error("Cannot create package item for invalid or root path.");
    }

    let existingItem = packagesMap.get(fullPackagePath);
    if (existingItem) {
        return existingItem;
    }

    let parentPackagePath = '';
    let packageDisplayName = '';

    if (fullPackagePath.startsWith('//')) {
        const pathWithoutSlashes = fullPackagePath.substring(2);
        const lastSlash = pathWithoutSlashes.lastIndexOf('/');
        if (lastSlash === -1) {
            parentPackagePath = '//';
            packageDisplayName = pathWithoutSlashes;
        } else {
            parentPackagePath = `//${pathWithoutSlashes.substring(0, lastSlash)}`;
            packageDisplayName = pathWithoutSlashes.substring(lastSlash + 1);
        }
    } else {
        console.warn(`Unexpected package path format: ${fullPackagePath}`);
        packageDisplayName = fullPackagePath;
        parentPackagePath = '//';
    }

    let parentCollection: vscode.TestItemCollection = controller.items;
    if (parentPackagePath !== '//') {
        const parentItem = getOrCreatePackageTestItemRecursive(parentPackagePath, controller, adapterInfo, packagesMap);
        parentCollection = parentItem.children;
    }

    const packageDir = fullPackagePath.startsWith("//") ? fullPackagePath.substring(2) : fullPackagePath;
    const packageUri = vscode.Uri.file(path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDir));

    const newItem = controller.createTestItem(fullPackagePath, packageDisplayName, packageUri);
    newItem.canResolveChildren = true;
    packagesMap.set(fullPackagePath, newItem);
    parentCollection.add(newItem);

    return newItem;
}

// Helper function to create a TestItem for a test rule
async function createTestRuleItem( // Changed to async due to await vscode.workspace.fs.stat
    rule: blaze_query.IRule,
    controller: vscode.TestController,
    adapterInfo: IBazelTestAdapterWorkspaceInfo,
    parentPackagePath: string
): Promise<vscode.TestItem | undefined> { // Changed to Promise
    const bazelLabel = rule.name;
    const kind = rule.ruleClass;

    if (!bazelLabel || !kind) {
        console.warn("Skipping target with missing label or kind:", rule);
        return undefined;
    }

    const ruleNameOnly = bazelLabel.substring(bazelLabel.lastIndexOf(':') + 1);

    // Determine URI and Range from rule.location
    // The packageItem's URI is not directly available here, so we use parentPackagePath
    const packageDirForUri = parentPackagePath.startsWith("//") ? parentPackagePath.substring(2) : parentPackagePath;
    let testRuleItemUri = vscode.Uri.file(path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDirForUri)); // Default to package dir URI initially
    let testRuleItemRange: vscode.Range | undefined;

    if (rule.location) {
        const parts = rule.location.split(':');
        if (parts.length >= 2) {
            const filePath = parts[0];
            const lineNumber = parseInt(parts[1], 10);
            // Ensure path is absolute and within the workspace.
            // Bazel rule locations can sometimes be outside the workspace (e.g. generated files in bazel-out)
            // or be non-file paths.
            if (!isNaN(lineNumber) && path.isAbsolute(filePath) && filePath.startsWith(adapterInfo.workspaceFolder.uri.fsPath)) {
                testRuleItemUri = vscode.Uri.file(filePath);
                testRuleItemRange = new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, 0));
            } else {
                // Fallback: if location is odd, try to point to the BUILD file in the package.
                console.warn(`Could not parse location for ${bazelLabel}: ${rule.location}. Using package URI or BUILD file.`);
                const buildFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDirForUri, 'BUILD');
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath)); // Check if BUILD file exists
                    testRuleItemUri = vscode.Uri.file(buildFilePath);
                } catch {
                    const buildBazelFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDirForUri, 'BUILD.bazel');
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.file(buildBazelFilePath)); // Check for BUILD.bazel
                        testRuleItemUri = vscode.Uri.file(buildBazelFilePath);
                    } catch {
                        // If neither BUILD nor BUILD.bazel exists, stick to the package directory URI.
                    }
                }
            }
        }
    } else {
        // Fallback if no rule.location: try to point to the BUILD file.
        const buildFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDirForUri, 'BUILD');
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath));
            testRuleItemUri = vscode.Uri.file(buildFilePath);
        } catch {
            const buildBazelFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDirForUri, 'BUILD.bazel');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(buildBazelFilePath));
                testRuleItemUri = vscode.Uri.file(buildBazelFilePath);
            } catch {
                 // Stick to package directory
            }
        }
    }

    const testRuleItem = controller.createTestItem(bazelLabel, ruleNameOnly, testRuleItemUri);
    if (testRuleItemRange) {
        testRuleItem.range = testRuleItemRange;
    }
    testRuleItem.canResolveChildren = false;
    testItemData.set(testRuleItem, { bazelLabel, kind, package: parentPackagePath });
    return testRuleItem;
}


export async function discoverAllTestsInWorkspace(
  controller: vscode.TestController,
  adapterInfo: IBazelTestAdapterWorkspaceInfo,
  context: vscode.ExtensionContext
): Promise<void> {
  vscode.window.showInformationMessage("Bazel test discovery started...");
  const bazelQuery = new BazelQuery(
    adapterInfo.bazelExecutablePath,
    adapterInfo.workspaceFolder.uri.fsPath,
    []
  );

  // discoverAllTestsInWorkspace will now use the module-scoped packagesMap.
  // It should be cleared by the caller (e.g. fullRefresh or initial resolve)
  // controller.items.replace([]); // Caller should handle clearing controller items if it's a full refresh.
  // packagesMap.clear(); // Caller should handle clearing packagesMap if it's a full refresh.


  try {
    const queryResult = await bazelQuery.queryTargets('kind(".*_test rule", //...)');

    if (queryResult && queryResult.target) {
      for (const target of queryResult.target) {
        if (target.type === 1 && target.rule) {
          const rule = target.rule;
          if (!rule.name) { // Early check for rule name
            console.warn("Skipping target with missing rule name:", target);
            continue;
          }
          const packagePath = rule.name.substring(0, rule.name.lastIndexOf(':'));
          const packageItem = getOrCreatePackageTestItemRecursive(packagePath, controller, adapterInfo, packagesMap);

          // Use the new helper function
          const testRuleItem = await createTestRuleItem(rule, controller, adapterInfo, packagePath);
          if (testRuleItem) {
            packageItem.children.add(testRuleItem);
          }
        }
      }
    }
    vscode.window.showInformationMessage(`Bazel test discovery finished. Found ${queryResult.target?.length || 0} total targets.`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error during Bazel test discovery: ${error.message || error}`);
    console.error("Bazel query failed:", error);
  }
}

export const runHandler = async (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    context: vscode.ExtensionContext,
    controller: vscode.TestController,
    currentTestItemData: WeakMap<vscode.TestItem, { bazelLabel: string, kind: string, package: string }>,
    fsApi: TestExplorerFs, // Added fsApi parameter
    getWorkspaceInfoFunc: typeof getBazelTestAdapterWorkspaceInfo // For dependency injection
  ) => {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    const adapterInfo = getWorkspaceInfoFunc(context); // Use injected function
    if (!adapterInfo) {
      vscode.window.showErrorMessage("Cannot run tests: Bazel workspace information is not available.");
      run.end();
      return;
    }

    if (request.include) {
      request.include.forEach(item => queue.push(item));
    } else {
      // If no specific items are requested, run all "leaf" tests that are actual Bazel targets.
      const collectAllRunnableTests = (item: vscode.TestItem, collection: vscode.TestItem[]) => {
            const data = currentTestItemData.get(item);
            if (data && data.kind !== 'package' && data.kind !== 'testcase') {
                // This is a runnable Bazel target rule
                console.log(`[CollectForRun] Adding: ${item.id}, kind: ${data.kind}`);
                collection.push(item);
            } else if (data && data.kind === 'package') {
                // This is a package, recurse into its children
                item.children.forEach(child => collectAllRunnableTests(child, collection));
            }
            // Do not add 'testcase' items directly, and do not recurse into children of runnable targets
            // (which would be 'testcase' items after XML parsing).
      };
      controller.items.forEach(pkgOrTestItem => collectAllRunnableTests(pkgOrTestItem, queue));
    }

    const testsToRun = queue.filter(testItem => !request.exclude?.includes(testItem));

    for (const testItem of testsToRun) {
      if (token.isCancellationRequested) {
        run.skipped(testItem);
        continue;
      }

      run.started(testItem);
      const testData = currentTestItemData.get(testItem);

      if (!testData) {
        run.errored(testItem, [{ message: "Test data not found for this item." }]);
        continue;
      }

      // Corrected check for skippable items
      if (testData.kind === 'package' || testData.kind === 'testcase') {
          logTestOutput(run, `[RunLoop] Skipping non-runnable item: ${testItem.id} (kind: ${testData.kind})`, testItem);
          run.skipped(testItem);
          continue;
      }

      const { bazelLabel, kind } = testData; // Destructure after the check
      console.log(`[RunLoop] Preparing to run: ${bazelLabel}, kind: ${kind}`);
      const startTime = Date.now();

      logTestOutput(run, `Executing: bazel test ${bazelLabel}\r\n`, testItem);

      const bazelExecutablePath = adapterInfo.bazelExecutablePath;
      const startupOptions = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('startupOptions') || [];
      const commandArgs = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('commandArgs') || [];

      const args = [
        ...startupOptions, 'test', ...commandArgs,
        '--test_output=streamed',
        '--verbose_failures',
        '--color=no',
        bazelLabel,
      ];

      await new Promise<void>((resolve) => {
        const child = child_process.spawn(bazelExecutablePath, args, { cwd: adapterInfo.workspaceFolder.uri.fsPath });
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

        child.on('close', async (code) => {
          const duration = Date.now() - startTime;
          let overallTargetSuccess = true;

          if (code === 0 || code === 3) {
            const symlinkTestlogsPath = path.join(adapterInfo.workspaceFolder.uri.fsPath, 'bazel-testlogs');
            let effectiveLabel = bazelLabel;

            if (effectiveLabel.startsWith('@')) {
              const repoNameEnd = effectiveLabel.indexOf('//');
              if (repoNameEnd > 1) {
                const repoName = effectiveLabel.substring(1, repoNameEnd);
                effectiveLabel = `external/${repoName}/${effectiveLabel.substring(repoNameEnd + 2)}`;
              } else {
                 effectiveLabel = effectiveLabel.startsWith('//') ? effectiveLabel.substring(2) : effectiveLabel;
              }
               console.warn(`External repo label ${bazelLabel} - test.xml path construction might be inaccurate using symlink.`);
            } else if (effectiveLabel.startsWith('//')) {
              effectiveLabel = effectiveLabel.substring(2);
            }

            const parts = effectiveLabel.split(':');
            if (parts.length === 2) {
              const packagePathForXml = parts[0];
              const targetName = parts[1];
              const xmlPath = path.join(symlinkTestlogsPath, packagePathForXml, targetName, 'test.xml');
              logTestOutput(run, `Attempting to read test.xml using symlink path: ${xmlPath}`, testItem);

              try {
                const xmlContent = await fsApi.readFile(vscode.Uri.file(xmlPath)); // Use fsApi
                    const parsedXml = await xml2js.parseStringPromise(xmlContent.toString());
                    logTestOutput(run, `Successfully parsed ${xmlPath}`, testItem);

                    testItem.children.replace([]);

                    if (parsedXml.testsuites && parsedXml.testsuites.testsuite) {
                      for (const testsuite of parsedXml.testsuites.testsuite) {
                        if (testsuite.testcase) {
                          for (const testcase of testsuite.testcase) {
                            const caseName = testcase.$.name;
                            const caseClassname = testcase.$.classname;
                            const caseLabel = caseClassname && !caseName.startsWith(caseClassname) ? `${caseClassname}.${caseName}` : caseName;
                            const caseId = `${testItem.id}/${caseLabel.replace(/\s+/g, '_').replace(/\//g, '_')}`;
                            const caseUri = testItem.uri;
                            const caseItem = controller.createTestItem(caseId, caseLabel, caseUri);
                            const parentTestData = currentTestItemData.get(testItem);
                            currentTestItemData.set(caseItem, {
                              bazelLabel: caseId,
                              kind: 'testcase',
                              package: parentTestData?.package || ''
                            });
                            const caseDuration = parseFloat(testcase.$.time) * 1000;

                            if (testcase.failure) {
                              overallTargetSuccess = false;
                              const failures = testcase.failure.map((f: any) =>
                                new vscode.TestMessage(f._ || (f.$ && f.$.message) || 'Unknown failure')
                              );
                              run.failed(caseItem, failures, caseDuration);
                            } else if (testcase.error) {
                              overallTargetSuccess = false;
                              const errors = testcase.error.map((e: any) =>
                                new vscode.TestMessage(e._ || (e.$ && e.$.message) || 'Unknown error')
                              );
                              run.errored(caseItem, errors, caseDuration);
                            } else if (testcase.skipped) {
                              run.skipped(caseItem);
                            } else {
                              run.passed(caseItem, caseDuration);
                            }
                            testItem.children.add(caseItem);
                          }
                        } else {
                          logTestOutput(run, `No testcases found in testsuite: ${testsuite.$.name}`, testItem);
                        }
                      }
                    } else {
                      logTestOutput(run, `No testsuites found in ${xmlPath}. Structure: ${Object.keys(parsedXml)}`, testItem);
                      if (code === 0) overallTargetSuccess = false;
                    }
                  } catch (e: any) {
                    logTestOutput(run, `Error processing test.xml from ${xmlPath}: ${e.message}`, testItem);
                    overallTargetSuccess = false;
                  }
                } else {
                  logTestOutput(run, `Could not parse package and target from label: ${bazelLabel} to find test.xml`, testItem);
                  overallTargetSuccess = false;
                }
          }


          if (token.isCancellationRequested) {
            run.skipped(testItem);
          } else {
            if (code === 0 && !overallTargetSuccess) {
              run.failed(testItem, [{ message: 'Test target passed overall, but issues found processing test.xml or individual test cases failed/errored.' }], duration);
            } else if (code === 3) {
                 run.failed(testItem, [{ message: 'Tests failed. See individual results or output log for details.' }], duration);
            } else if (code === 0 && overallTargetSuccess) {
                run.passed(testItem, duration);
            } else if (code === 1) {
                 run.errored(testItem, [{ message: 'Build failed. See output for details.' }], duration);
            } else if (code === 4) {
                 run.skipped(testItem);
                logTestOutput(run, `No tests found by Bazel for target: ${bazelLabel}`, testItem);
            } else {
                run.errored(testItem, [{ message: `Test execution failed with an unexpected Bazel exit code ${code}. See output for details.` }], duration);
            }
          }
          resolve();
        });
      });
    }
    run.end();
  };

export function activateBazelTests(context: vscode.ExtensionContext): void {
  moduleBazelTestController = vscode.tests.createTestController(
    'bazelTests',
    'Bazel Tests'
  );
  context.subscriptions.push(moduleBazelTestController);

  moduleBazelTestController.resolveHandler = async (item?: vscode.TestItem) => {
    if (!item) {
      const adapterInfo = getBazelTestAdapterWorkspaceInfo(context);
      if (adapterInfo) {
        moduleBazelTestController.items.replace([]); // Clear existing items before rediscovery
        await discoverAllTestsInWorkspace(moduleBazelTestController, adapterInfo, context);
      } else {
        vscode.window.showErrorMessage("Failed to get Bazel workspace info for test discovery. Test discovery aborted.");
      }
    } else {
      // TODO: Handle user expanding a TestItem - currently, full refresh is done.
      // Potentially, we could resolve children of 'item' if it's a package.
      // For now, the full resolve handles this.
    }
  };

  const runProfile = moduleBazelTestController.createRunProfile( // Store the profile
    'Run Tests',
    vscode.TestRunProfileKind.Run,
    // Pass the real getBazelTestAdapterWorkspaceInfo function
    (request, token) => runHandler(request, token, context, moduleBazelTestController, testItemData, vscode.workspace.fs, getBazelTestAdapterWorkspaceInfo),
    true
  );
  // Optional: if you want to set it as default for some reason
  // runProfile.isDefault = true;

  const adapterInfo = getBazelTestAdapterWorkspaceInfo(context);
  if (adapterInfo) { // Renamed initialAdapterInfo to adapterInfo for clarity
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(adapterInfo.workspaceFolder, '**/{BUILD,BUILD.bazel,*.bzl}')
    );
    context.subscriptions.push(watcher);

    // Full refresh clears everything and re-discovers.
    const fullRefresh = async (uri?: vscode.Uri) => {
      if (uri) {
        vscode.window.showInformationMessage(`File change detected (${uri.fsPath}), triggering full test refresh.`);
      } else {
        vscode.window.showInformationMessage(`Triggering full test refresh.`);
      }

      const currentAdapterInfo = getBazelTestAdapterWorkspaceInfo(context); // Re-fetch, in case of config changes
      if (currentAdapterInfo) {
        moduleBazelTestController.items.replace([]);
        packagesMap.clear(); // Clear the module-scoped map
        await discoverAllTestsInWorkspace(moduleBazelTestController, currentAdapterInfo, context);
      } else {
        vscode.window.showWarningMessage("Workspace info became unavailable. Cannot refresh tests after file change.");
      }
    };

    // Initial population
    moduleBazelTestController.resolveHandler = async (item?: vscode.TestItem) => {
        if (!item) {
            await fullRefresh(); // Initial call or manual refresh
        } else {
            // TODO: Handle user expanding a TestItem if needed for lazy-loading sub-packages/tests
            // For now, full resolve handles this, or granular updates will fix children.
        }
    };


    watcher.onDidChange(async (uri) => {
      console.log(`File changed: ${uri.fsPath}`);
      const fileName = path.basename(uri.fsPath);
      if (fileName === 'BUILD' || fileName === 'BUILD.bazel') {
        const packagePath = determinePackagePathFromUri(uri, adapterInfo);
        if (packagePath) {
          await updateTestsInPackage(packagePath, moduleBazelTestController, adapterInfo, context);
        }
      } else if (uri.fsPath.endsWith(".bzl")) {
        await fullRefresh(uri);
      }
    });

    watcher.onDidCreate(async (uri) => {
      console.log(`File created: ${uri.fsPath}`);
      const fileName = path.basename(uri.fsPath);
      if (fileName === 'BUILD' || fileName === 'BUILD.bazel') {
        const packagePath = determinePackagePathFromUri(uri, adapterInfo);
        if (packagePath) {
          await updateTestsInPackage(packagePath, moduleBazelTestController, adapterInfo, context);
        }
      } else if (uri.fsPath.endsWith(".bzl")) {
        // Creating a .bzl file might not immediately affect tests until it's used in a BUILD file.
        // A full refresh might be too broad, but changes to BUILD files that use it will trigger updates.
        // For simplicity now, or if it defines global macros, a full refresh could be considered.
        // However, let's assume BUILD file changes will cover this. No full refresh here for now.
      }
    });

    watcher.onDidDelete(async (uri) => {
      console.log(`File deleted: ${uri.fsPath}`);
      const fileName = path.basename(uri.fsPath);
      if (fileName === 'BUILD' || fileName === 'BUILD.bazel') {
        const bazelPackagePath = determinePackagePathFromUri(uri, adapterInfo);
        if (bazelPackagePath) {
          vscode.window.showInformationMessage(`BUILD file deleted (${uri.fsPath}), removing package ${bazelPackagePath}.`);
          const packageItemToDelete = packagesMap.get(bazelPackagePath);
          if (packageItemToDelete) {
            const collection = packageItemToDelete.parent ? packageItemToDelete.parent.children : moduleBazelTestController.items;
            collection.delete(packageItemToDelete.id);
            packagesMap.delete(bazelPackagePath);
            // Also remove children from testItemData? Or assume they are not accessed anymore.
          }
        }
      } else if (uri.fsPath.endsWith(".bzl")) {
        await fullRefresh(uri); // A deleted .bzl file could break many things.
      }
    });
  } else {
    vscode.window.showWarningMessage("Bazel workspace info not available. File watchers for test discovery not activated.");
  }
}

// Helper to determine Bazel package path from a file URI
function determinePackagePathFromUri(uri: vscode.Uri, adapterInfo: IBazelTestAdapterWorkspaceInfo): string | undefined {
    const workspaceRootPath = adapterInfo.workspaceFolder.uri.fsPath;
    const filePath = uri.fsPath;

    if (!filePath.startsWith(workspaceRootPath)) {
        console.warn(`File ${filePath} is not within workspace ${workspaceRootPath}`);
        return undefined;
    }

    // Get path of the directory containing the BUILD file, relative to workspace root
    let relativeDirPath = path.dirname(filePath.substring(workspaceRootPath.length));

    // Normalize: remove leading slash if present, handle Windows separators
    if (relativeDirPath.startsWith(path.sep)) {
        relativeDirPath = relativeDirPath.substring(1);
    }
    relativeDirPath = relativeDirPath.replace(/\\/g, '/'); // Ensure forward slashes for Bazel

    if (relativeDirPath === '.' || relativeDirPath === '') {
        return '//'; // Package in workspace root
    }

    return `//${relativeDirPath}`;
}


// Function to update tests for a specific package
async function updateTestsInPackage(
    bazelPackagePath: string,
    controller: vscode.TestController,
    adapterInfo: IBazelTestAdapterWorkspaceInfo,
    context: vscode.ExtensionContext
): Promise<void> {
    console.log(`Updating tests for package: ${bazelPackagePath}`);

    // This will get or create the package item, crucial for new BUILD files.
    const packageItem = getOrCreatePackageTestItemRecursive(bazelPackagePath, controller, adapterInfo, packagesMap);

    const bazelQuery = new BazelQuery(adapterInfo.bazelExecutablePath, adapterInfo.workspaceFolder.uri.fsPath, []);
    let queryResult: blaze_query.IQueryResult | undefined;
    try {
        queryResult = await bazelQuery.queryTargets(`kind(".*_test rule", ${bazelPackagePath}:all)`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error querying tests in package ${bazelPackagePath}: ${error.message || error}`);
        console.error(`Bazel query failed for package ${bazelPackagePath}:`, error);
        // Optionally, clear children of packageItem if query fails, or leave them stale.
        // packageItem.children.replace([]); // This would remove potentially still valid tests if query is flaky.
        return;
    }

    const existingChildItemsById = new Map<string, vscode.TestItem>();
    packageItem.children.forEach(child => existingChildItemsById.set(child.id, child));
    const currentTestRuleLabelsInPackage = new Set<string>();

    if (queryResult && queryResult.target) {
        for (const target of queryResult.target) {
            if (target.type === 1 && target.rule) {
                const rule = target.rule;
                const testRuleItem = await createTestRuleItem(rule, controller, adapterInfo, bazelPackagePath);
                if (testRuleItem) {
                    currentTestRuleLabelsInPackage.add(testRuleItem.id);
                    const existingItem = existingChildItemsById.get(testRuleItem.id);
                    if (existingItem) {
                        // Rule still exists. To ensure all properties (especially read-only URI and potentially range) are updated,
                        // remove the old item and add the new one created by createTestRuleItem.
                        packageItem.children.delete(existingItem.id);
                        testItemData.delete(existingItem); // Clean up data associated with the old TestItem instance
                    }
                    // Add the new or updated testRuleItem.
                    // testItemData is already correctly associated with testRuleItem by createTestRuleItem.
                    packageItem.children.add(testRuleItem);
                }
            }
        }
    }

    // Remove old tests that are no longer found by the query
    existingChildItemsById.forEach((oldItem, oldId) => {
        if (!currentTestRuleLabelsInPackage.has(oldId)) {
            packageItem.children.delete(oldId);
            // packagesMap.delete(oldId); // oldId is a bazelLabel (e.g., //pkg:rule), not a packagePath. Only package items go in packagesMap.
            testItemData.delete(oldItem); // Clean up associated data
        }
    });
    console.log(`Finished updating tests for package: ${bazelPackagePath}. Found ${packageItem.children.size} tests.`);
}

export function getBazelTestController(): vscode.TestController {
  if (!moduleBazelTestController) {
    throw new Error('Bazel Test Controller not activated');
  }
  return moduleBazelTestController;
}
