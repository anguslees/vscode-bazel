import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as xml2js from 'xml2js';
import { BazelQuery } from '../bazel/bazel_query';
import { BazelWorkspaceInfo } from '../bazel/bazel_workspace_info';
import { BazelInfo } from '../bazel/bazel_info';
import { blaze_query } from '../protos';

let bazelTestController: vscode.TestController;
const testItemData = new WeakMap<vscode.TestItem, { bazelLabel: string, kind: string, package: string }>();

export interface IBazelTestAdapterWorkspaceInfo {
  bazelWorkspace: BazelWorkspaceInfo;
  bazelExecutablePath: string;
  workspaceFolder: vscode.WorkspaceFolder;
}

function logTestOutput(run: vscode.TestRun, message: string, item?: vscode.TestItem) {
  console.log(message);
  const sanitizedMessage = message.replace(/\r?\n/g, '\r\n');
  run.appendOutput(`${sanitizedMessage}\r\n`, undefined, item);
}

function getBazelTestAdapterWorkspaceInfo(context: vscode.ExtensionContext): IBazelTestAdapterWorkspaceInfo | undefined {
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

  controller.items.replace([]);
  const packagesMap = new Map<string, vscode.TestItem>();

  try {
    const queryResult = await bazelQuery.queryTargets('kind(".*_test rule", //...)');

    if (queryResult && queryResult.target) {
      for (const target of queryResult.target) {
        if (target.type === 1 && target.rule) {
          const rule = target.rule;
          const bazelLabel = rule.name;
          const kind = rule.ruleClass;

          if (!bazelLabel || !kind) {
            console.warn("Skipping target with missing label or kind:", target);
            continue;
          }

          const packagePath = bazelLabel.substring(0, bazelLabel.lastIndexOf(':'));
          const ruleNameOnly = bazelLabel.substring(bazelLabel.lastIndexOf(':') + 1);

          const packageItem = getOrCreatePackageTestItemRecursive(packagePath, controller, adapterInfo, packagesMap);

          const packageDir = packagePath.startsWith("//") ? packagePath.substring(2) : packagePath;
          let testRuleItemUri = packageItem.uri!;
          let testRuleItemRange: vscode.Range | undefined;

          if (rule.location) {
            const parts = rule.location.split(':');
            if (parts.length >= 2) {
              const filePath = parts[0];
              const lineNumber = parseInt(parts[1], 10);
              if (!isNaN(lineNumber) && filePath.startsWith(adapterInfo.workspaceFolder.uri.fsPath)) {
                testRuleItemUri = vscode.Uri.file(filePath);
                testRuleItemRange = new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, 0));
              } else {
                console.warn(`Could not parse location for ${bazelLabel}: ${rule.location}. Using package URI.`);
                const buildFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDir, 'BUILD');
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath));
                    testRuleItemUri = vscode.Uri.file(buildFilePath);
                } catch {
                    // Stick to packageItem.uri
                }
              }
            }
          } else {
             const buildFilePath = path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDir, 'BUILD');
             try {
                await vscode.workspace.fs.stat(vscode.Uri.file(buildFilePath));
                testRuleItemUri = vscode.Uri.file(buildFilePath);
             } catch {
                // Stick to packageItem.uri
             }
          }

          const testRuleItem = controller.createTestItem(bazelLabel, ruleNameOnly, testRuleItemUri);
          if (testRuleItemRange) {
            testRuleItem.range = testRuleItemRange;
          }
          testRuleItem.canResolveChildren = false;
          testItemData.set(testRuleItem, { bazelLabel, kind, package: packagePath });
          packageItem.children.add(testRuleItem);
        }
      }
    }
    vscode.window.showInformationMessage(`Bazel test discovery finished. Found ${queryResult.target?.length || 0} total targets.`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error during Bazel test discovery: ${error.message || error}`);
    console.error("Bazel query failed:", error);
  }
}

export function activateBazelTests(context: vscode.ExtensionContext): void {
  bazelTestController = vscode.tests.createTestController(
    'bazelTests',
    'Bazel Tests'
  );
  context.subscriptions.push(bazelTestController);

  bazelTestController.resolveHandler = async (item?: vscode.TestItem) => {
    if (!item) {
      const adapterInfo = getBazelTestAdapterWorkspaceInfo(context);
      if (adapterInfo) {
        bazelTestController.items.replace([]);
        await discoverAllTestsInWorkspace(bazelTestController, adapterInfo, context);
      } else {
        vscode.window.showErrorMessage("Failed to get Bazel workspace info for test discovery. Test discovery aborted.");
      }
    } else {
      // TODO: Handle user expanding a TestItem
    }
  };

  const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const run = bazelTestController.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    const adapterInfo = getBazelTestAdapterWorkspaceInfo(context);
    if (!adapterInfo) {
      vscode.window.showErrorMessage("Cannot run tests: Bazel workspace information is not available.");
      run.end();
      return;
    }

    if (request.include) {
      request.include.forEach(item => queue.push(item));
    } else {
      const collectAllLeafTests = (item: vscode.TestItem, collection: vscode.TestItem[]) => {
          if (item.children.size === 0 && !item.canResolveChildren) {
              collection.push(item);
          } else {
              item.children.forEach(child => collectAllLeafTests(child, collection));
          }
      };
      bazelTestController.items.forEach(pkgOrTestItem => collectAllLeafTests(pkgOrTestItem, queue));
    }

    const testsToRun = queue.filter(testItem => {
        const data = testItemData.get(testItem);
        return data && data.kind !== 'package' && !request.exclude?.includes(testItem);
    });

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
            // Construct path to test.xml using the bazel-testlogs symlink
            const symlinkTestlogsPath = path.join(adapterInfo.workspaceFolder.uri.fsPath, 'bazel-testlogs');
            let effectiveLabel = bazelLabel;

            if (effectiveLabel.startsWith('@')) {
              // Handle external repo labels by trying to map them to a path under bazel-testlogs/external/...
              // This is an approximation. The exact structure can vary.
              const repoNameEnd = effectiveLabel.indexOf('//');
              if (repoNameEnd > 1) {
                const repoName = effectiveLabel.substring(1, repoNameEnd);
                effectiveLabel = `external/${repoName}/${effectiveLabel.substring(repoNameEnd + 2)}`;
              } else {
                 // Fallback for malformed external labels, or treat as non-external.
                 effectiveLabel = effectiveLabel.startsWith('//') ? effectiveLabel.substring(2) : effectiveLabel;
              }
               console.warn(`External repo label ${bazelLabel} - test.xml path construction might be inaccurate using symlink.`);
            } else if (effectiveLabel.startsWith('//')) {
              effectiveLabel = effectiveLabel.substring(2);
            }

            const parts = effectiveLabel.split(':');
            if (parts.length === 2) {
              const packagePathForXml = parts[0]; // This is now relative path like "foo/bar"
              const targetName = parts[1];
              const xmlPath = path.join(symlinkTestlogsPath, packagePathForXml, targetName, 'test.xml');
              logTestOutput(run, `Attempting to read test.xml using symlink path: ${xmlPath}`, testItem);

              try {
                const xmlContent = await vscode.workspace.fs.readFile(vscode.Uri.file(xmlPath));
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
                            const caseItem = bazelTestController.createTestItem(caseId, caseLabel, caseUri);
                            const parentTestData = testItemData.get(testItem);
                            testItemData.set(caseItem, {
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
                  } catch (e: any) { // This catch is for XML parsing / processing
                    logTestOutput(run, `Error processing test.xml from ${xmlPath}: ${e.message}`, testItem);
                    overallTargetSuccess = false;
                  }
                } else { // This else is for parts.length !== 2
                  logTestOutput(run, `Could not parse package and target from label: ${bazelLabel} to find test.xml`, testItem);
                  overallTargetSuccess = false;
                }
            // Removed the try-catch block that was specific to BazelInfo call
            // The file system access for test.xml is handled by its own try-catch now.
            // If xmlPath cannot be determined or read, overallTargetSuccess will be false.
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

  bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true);

  // Debug handler and profile registration removed for now to isolate build error.

  const initialAdapterInfo = getBazelTestAdapterWorkspaceInfo(context);
  if (initialAdapterInfo) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(initialAdapterInfo.workspaceFolder, '**/{BUILD,BUILD.bazel,*.bzl}')
    );
    context.subscriptions.push(watcher);

    const fullRefresh = async (uri: vscode.Uri) => {
      vscode.window.showInformationMessage(`File change detected (${uri.fsPath}), triggering full test refresh.`);
      const currentAdapterInfo = getBazelTestAdapterWorkspaceInfo(context);
      if (currentAdapterInfo) {
        bazelTestController.items.replace([]);
        await discoverAllTestsInWorkspace(bazelTestController, currentAdapterInfo, context);
      } else {
        vscode.window.showWarningMessage("Workspace info became unavailable. Cannot refresh tests after file change.");
      }
    };

    watcher.onDidChange(async (uri) => {
      await fullRefresh(uri);
    });

    watcher.onDidCreate(async (uri) => {
      await fullRefresh(uri);
    });

    watcher.onDidDelete(async (uri) => {
      const fileName = path.basename(uri.fsPath);
      if (fileName === 'BUILD' || fileName === 'BUILD.bazel') {
        const packageDirRelativePath = path.dirname(vscode.workspace.asRelativePath(uri, false));
        const bazelPackagePath = `//${packageDirRelativePath.replace(/\\/g, '/')}`;
        vscode.window.showInformationMessage(`BUILD file deleted (${uri.fsPath}), removing package ${bazelPackagePath}.`);
        const packageItem = bazelTestController.items.get(bazelPackagePath);
        if (packageItem) {
          bazelTestController.items.delete(bazelPackagePath);
        } else {
          vscode.window.showWarningMessage(`Package ${bazelPackagePath} not found directly, consider full refresh if issues persist.`);
        }
      } else if (uri.fsPath.endsWith(".bzl")) {
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
