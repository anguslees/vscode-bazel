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

// Interface for the combined workspace info needed by the adapter
export interface IBazelTestAdapterWorkspaceInfo { // Added export
  bazelWorkspace: BazelWorkspaceInfo; // Instance from BazelWorkspaceInfo class
  bazelExecutablePath: string;
  workspaceFolder: vscode.WorkspaceFolder;
  // Potentially add executionRoot if routinely needed and available from BazelInfo
  // executionRoot?: string;
}

// Helper function for logging
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

  const workspaceFolder = workspaceFolders[0]; // Using the first workspace folder
  const bazelWorkspace = BazelWorkspaceInfo.fromWorkspaceFolder(workspaceFolder);

  if (!bazelWorkspace) {
    vscode.window.showErrorMessage(`Folder '${workspaceFolder.name}' is not a Bazel workspace.`);
    return undefined;
  }

  const bazelConfig = vscode.workspace.getConfiguration("bazel");
  // Default to "bazel" if not set, allowing it to be found on PATH
  const bazelExecutablePath = bazelConfig.get<string>("executable") || "bazel";

  return { bazelWorkspace, bazelExecutablePath, workspaceFolder };
}

export async function discoverAllTestsInWorkspace(
  controller: vscode.TestController,
  adapterInfo: IBazelTestAdapterWorkspaceInfo, // Updated parameter
  context: vscode.ExtensionContext
): Promise<void> {
  vscode.window.showInformationMessage("Bazel test discovery started...");
  const bazelQuery = new BazelQuery(
    adapterInfo.bazelExecutablePath,
    adapterInfo.workspaceFolder.uri.fsPath,
    [] // Corrected: options should be string[]
  );

  try {
    const queryResult = await bazelQuery.queryTargets('kind(".*_test rule", //...)');
    const packages = new Map<string, vscode.TestItem>();

    if (queryResult && queryResult.target) {
      for (const target of queryResult.target) {
        // Assuming target.type is a numeric enum and RULE is likely 1
        if (target.type === 1 && target.rule) { // Comparing with numeric value 1 for RULE
          const rule = target.rule;
          const bazelLabel = rule.name;
          const kind = rule.ruleClass;

          if (!bazelLabel || !kind) {
            console.warn("Skipping target with missing label or kind:", target);
            continue;
          }

          const packagePath = bazelLabel.substring(0, bazelLabel.lastIndexOf(':'));
          const ruleNameOnly = bazelLabel.substring(bazelLabel.lastIndexOf(':') + 1);
          const packageDir = packagePath.startsWith("//") ? packagePath.substring(2) : packagePath;

          let packageItem = packages.get(packagePath);
          if (!packageItem) {
            const packageDisplayName = path.basename(packageDir) || path.dirname(packageDir);
            const packageUri = vscode.Uri.file(path.join(adapterInfo.workspaceFolder.uri.fsPath, packageDir));
            packageItem = controller.createTestItem(packagePath, packageDisplayName, packageUri);
            packageItem.canResolveChildren = false;
            controller.items.add(packageItem);
            packages.set(packagePath, packageItem);
          }

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
        await discoverAllTestsInWorkspace(bazelTestController, adapterInfo, context);
      } else {
        vscode.window.showErrorMessage("Failed to get Bazel workspace info for test discovery. Test discovery aborted.");
      }
    } else {
      // TODO: Handle user expanding a TestItem.
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
      bazelTestController.items.forEach(item => {
        item.children.forEach(childItem => queue.push(childItem));
      });
    }

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
      const startTime = Date.now(); // Moved to correct scope

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
          let overallTargetSuccess = true; // Declare at this scope

          if (code === 0 || code === 3) {
            try {
              const bazelInfo = new BazelInfo(adapterInfo.bazelExecutablePath, adapterInfo.workspaceFolder.uri.fsPath);
              const testlogsPath = await bazelInfo.getOne('bazel-testlogs');

              if (testlogsPath) {
                let effectiveLabel = bazelLabel;
                if (effectiveLabel.startsWith('@')) {
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
                  logTestOutput(run, `Attempting to read test.xml from: ${xmlPath}`, testItem);

                  try {
                    const xmlContent = await vscode.workspace.fs.readFile(vscode.Uri.file(xmlPath));
                    const parsedXml = await xml2js.parseStringPromise(xmlContent.toString());
                    logTestOutput(run, `Successfully parsed ${xmlPath}`, testItem);

                    testItem.children.replace([]);
                    // overallTargetSuccess is already true here by declaration

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
                  } catch (e: any) {
                    logTestOutput(run, `Error processing test.xml from ${xmlPath}: ${e.message}`, testItem);
                    overallTargetSuccess = false;
                  }
                } else {
                  logTestOutput(run, `Could not parse package and target from label: ${bazelLabel} to find test.xml`, testItem);
                  overallTargetSuccess = false;
                }
              } else {
                logTestOutput(run, 'Warning: bazel-testlogs path not found, cannot locate test.xml.', testItem);
                if (code === 0) overallTargetSuccess = false;
              }
            } catch (err: any) {
              logTestOutput(run, `Error getting bazel-testlogs or processing XML: ${err.message}`, testItem);
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

  bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true);

  const debugHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const run = bazelTestController.createTestRun(request, 'Debug Run', false);
    const adapterInfo = getBazelTestAdapterWorkspaceInfo(context);

    if (!adapterInfo) {
      vscode.window.showErrorMessage("Cannot debug tests: Bazel workspace information is not available.");
      run.end();
      return;
    }

    if (!request.include || request.include.length === 0) {
      logTestOutput(run, "No tests selected for debugging. Please select tests from the Test Explorer.");
      run.end();
      return;
    }

    if (request.include.length > 1) {
      logTestOutput(run, "Debugging multiple test targets simultaneously is not supported. Please select a single test target.");
      for (const ti of request.include) { run.skipped(ti); }
      run.end();
      return;
    }

    const testItem = request.include[0];
    const testData = testItemData.get(testItem);

    if (!testData) {
      logTestOutput(run, `Test data not found for ${testItem.label}. Cannot debug.`, testItem);
      run.errored(testItem, [{ message: "Test data not found." }]);
      run.end();
      return;
    }

    const { bazelLabel, kind } = testData;
    run.started(testItem);
    const startTime = Date.now(); // Moved to correct scope for debugHandler

    if (kind === 'py_test') {
      logTestOutput(run, `Attempting to debug Python test: ${bazelLabel}`, testItem);
      const debugPort = 5678;

      const bazelExecutablePath = adapterInfo.bazelExecutablePath;
      const startupOptions = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('startupOptions') || [];
      const commandArgs = vscode.workspace.getConfiguration('bazel.commandLine').get<string[]>('commandArgs') || [];

      const bazelDebugArgs = [
        ...startupOptions, 'test', ...commandArgs,
        '--test_output=streamed',
        '--color=no',
        bazelLabel,
        `--test_arg=--debugpy_adapter_port=${debugPort}`,
        `--test_arg=--debugpy_wait_for_client=true`,
      ];

      logTestOutput(run, `Starting Bazel with args: ${bazelDebugArgs.join(' ')}`, testItem);
      const child = child_process.spawn(bazelExecutablePath, bazelDebugArgs, { cwd: adapterInfo.workspaceFolder.uri.fsPath });

      let bazelProcessClosed = false;
      let debugSessionStarted = false;

      child.stdout.on('data', (data) => logTestOutput(run, data.toString(), testItem));
      child.stderr.on('data', (data) => logTestOutput(run, data.toString(), testItem));

      const debugConfiguration: vscode.DebugConfiguration = {
        type: 'python',
        name: `Debug ${bazelLabel}`,
        request: 'attach',
        connect: { host: 'localhost', port: debugPort },
        pathMappings: [ { localRoot: adapterInfo.workspaceFolder.uri.fsPath, remoteRoot: adapterInfo.workspaceFolder.uri.fsPath }, ],
      };

      const startupDelay = 10000;
      logTestOutput(run, `Waiting ${startupDelay / 1000}s for debugpy to start...`, testItem);

      const timeoutId = setTimeout(async () => {
        if (bazelProcessClosed || token.isCancellationRequested) {
          if (!bazelProcessClosed) run.skipped(testItem);
          if (!debugSessionStarted) run.end();
          return;
        }
        try {
          logTestOutput(run, `Attempting to attach debugger to localhost:${debugPort}`, testItem);
          await vscode.debug.startDebugging(adapterInfo.workspaceFolder, debugConfiguration);
          debugSessionStarted = true;
          logTestOutput(run, 'Debug session successfully started.', testItem);
        } catch (e: any) {
          logTestOutput(run, `Error starting debug session: ${e.message}`, testItem);
          run.errored(testItem, [{ message: `Debug adapter failed to attach: ${e.message}` }]);
          if (!bazelProcessClosed) child.kill();
          run.end();
        }
      }, startupDelay);

      token.onCancellationRequested(() => {
        logTestOutput(run, 'Debug run cancelled by user.', testItem);
        clearTimeout(timeoutId);
        if (!bazelProcessClosed) {
           child.kill();
        } else {
            if(!debugSessionStarted) run.end();
        }
      });

      child.on('close', (code) => {
        bazelProcessClosed = true;
        clearTimeout(timeoutId);
        logTestOutput(run, `Bazel debug process exited with code: ${code}`, testItem);

        if (code === 0) {
          run.passed(testItem, Date.now() - startTime);
        } else if (code !== null) {
          run.failed(testItem, [{message: `Bazel process exited with code ${code}. Debug session might have failed or not started.`}], Date.now() - startTime);
        }
        if (!debugSessionStarted) {
            run.end();
        } else {
             logTestOutput(run, "Bazel process ended. Debug session may still be active or terminating.", testItem);
        }
      });

      child.on('error', (err) => {
        bazelProcessClosed = true;
        clearTimeout(timeoutId);
        logTestOutput(run, `Bazel debug process error: ${err.message}`, testItem);
        run.errored(testItem, [{ message: `Bazel process error: ${err.message}` }]);
        if (!debugSessionStarted) run.end();
      });

    } else {
      logTestOutput(run, `Debugging not yet supported for test kind: '${kind}'`, testItem);
      run.skipped(testItem);
      run.end();
    }
  };

  const debugProfile = bazelTestController.createRunProfile('Debug Tests', vscode.TestRunProfileKind.Debug, debugHandler);
  debugProfile.isDefault = false;

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
        bazelTestController.items.replace([]); // Corrected from clear()
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
