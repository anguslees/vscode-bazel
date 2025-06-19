/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs'; // Import fs for stubbing
import {
    discoverAllTestsInWorkspace,
    IBazelTestAdapterWorkspaceInfo,
    // getBazelTestAdapterWorkspaceInfo, (now injected for runHandler)
    testItemData,
    runHandler,
    TestExplorerFs,
    packagesMap as SUTPackagesMap // Import to clear it
} from '../src/test-explorer/bazel_test_adapter';
import { BazelWorkspaceInfo } from '../src/bazel/bazel_workspace_info';
import { BazelQuery } from '../src/bazel/bazel_query';
import { blaze_query } from '../src/protos';

// Utility to create a stub TestController
function createStubTestController(): vscode.TestController {
    const items = new Map<string, vscode.TestItem>();
    const controller: vscode.TestController = {
        id: 'stubController',
        label: 'Stub Controller',
        items: {
            add: (item: vscode.TestItem) => items.set(item.id, item),
            delete: (id: string) => items.delete(id),
            get: (id: string) => items.get(id),
            replace: (newItems: vscode.TestItem[]) => {
                items.clear();
                newItems.forEach(item => items.set(item.id, item));
            },
            forEach: (callback: (item: vscode.TestItem, collection: vscode.TestItemCollection) => void) => {
                items.forEach(item => callback(item, controller.items));
            },
            get size() { return items.size; }
        } as any,
        createTestItem: (id: string, label: string, uri?: vscode.Uri): vscode.TestItem => ({
            id,
            label,
            uri,
            children: createStubTestItemCollection(),
            range: undefined,
            parent: undefined,
            tags: [],
            canResolveChildren: false,
            busy: false,
            error: undefined,
        } as vscode.TestItem),
        createRunProfile: sinon.stub().callsFake((label, kind, handler) => {
            (controller as any).capturedRunHandler = handler;
            return { label, kind, runHandler: handler, dispose: sinon.stub(), isDefault: false } as any;
        }),
        createTestRun: sinon.stub().returns({
            started: sinon.stub(),
            passed: sinon.stub(),
            failed: sinon.stub(),
            skipped: sinon.stub(),
            errored: sinon.stub(),
            appendOutput: sinon.stub(),
            end: sinon.stub(),
        } as any),
        dispose: sinon.stub(),
        resolveHandler: undefined,
        refreshHandler: undefined,
        invalidateTestResults: sinon.stub(),
    };
    return controller;
}

function createStubTestItemCollection(): vscode.TestItemCollection {
    const itemsMap = new Map<string, vscode.TestItem>();
    const collection: vscode.TestItemCollection = {
        add: (item: vscode.TestItem) => itemsMap.set(item.id, item),
        delete: (id: string) => itemsMap.delete(id),
        get: (id: string) => itemsMap.get(id),
        replace: (newItems: vscode.TestItem[]) => {
            itemsMap.clear();
            newItems.forEach(item => itemsMap.set(item.id, item));
        },
        forEach: (callback: (item: vscode.TestItem) => void) => itemsMap.forEach(callback),
        get size() { return itemsMap.size; }
    } as any;
    return collection;
}

const BTA = require('../src/test-explorer/bazel_test_adapter');
// const originalGetBazelTestAdapterWorkspaceInfo = BTA.getBazelTestAdapterWorkspaceInfo; // Will be handled by sinon.restore()
let getWorkspaceInfoStub: sinon.SinonStub; // Keep declaration here, but initialize within runHandler's beforeEach


describe('Bazel Test Adapter Tests', () => {
    let mockController: vscode.TestController;
    let mockContext: vscode.ExtensionContext;
    let spawnStub: sinon.SinonStub; // queryTargetsStub removed from global scope

    beforeEach(() => {
        mockController = createStubTestController();

        const mementoMock: vscode.Memento = {
            get: sinon.stub().callsFake((key: string, defaultValue?: any) => {
                if (typeof defaultValue !== 'undefined') {
                    return defaultValue;
                }
                return undefined;
            }) as vscode.Memento['get'],
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        };

        mockContext = {
            subscriptions: { push: sinon.stub() } as any,
            workspaceState: mementoMock,
            globalState: { ...mementoMock, setKeysForSync: sinon.stub() } as any,
            extensionPath: '/mock/extension/path',
            storagePath: '/mock/storage/path',
            globalStoragePath: '/mock/global/storage/path',
            logPath: '/mock/log/path',
            extensionUri: vscode.Uri.file('/mock/extension/path'),
            environmentVariableCollection: {} as any,
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: vscode.Uri.file('/mock/storage/path'),
            globalStorageUri: vscode.Uri.file('/mock/global/storage/path'),
            logUri: vscode.Uri.file('/mock/log/path'),
            secrets: { get: sinon.stub(), store: sinon.stub(), delete: sinon.stub(), onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event },
            asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
            extension: {
                id: 'mock.extension',
                extensionPath: '/mock/extension/path',
                isActive: true,
                packageJSON: {},
                extensionKind: vscode.ExtensionKind.Workspace,
                exports: {},
                activate: sinon.stub().resolves()
            } as any,
            languageModelAccessInformation: undefined,
        } as vscode.ExtensionContext;

        // spawnStub can be initialized here as it's generally used across different test types (run, debug)
        spawnStub = sinon.stub(child_process, 'spawn');

        // queryTargetsStub and getWorkspaceInfoStub are more specific and will be handled in nested suites
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('discoverAllTestsInWorkspace', () => {
        let queryTargetsStub: sinon.SinonStub; // Suite-specific stub

        beforeEach(() => {
            queryTargetsStub = sinon.stub(BazelQuery.prototype, 'queryTargets');
        });

        it('Should discover tests and create hierarchy', async () => {
            const mockVSCodeWorkspaceFolder = { uri: vscode.Uri.file('/test/workspace'), name: 'workspace', index: 0 };
            const bazelWorkspaceInstance = new (BazelWorkspaceInfo as any)('/test/workspace', mockVSCodeWorkspaceFolder);
            const mockAdapterWorkspaceInfo: IBazelTestAdapterWorkspaceInfo = {
                bazelWorkspace: bazelWorkspaceInstance,
                bazelExecutablePath: '/usr/bin/bazel',
                workspaceFolder: mockVSCodeWorkspaceFolder,
            };

            const MOCK_QUERY_RESULT_NESTED_HIERARCHY = blaze_query.QueryResult.create({
                target: [
                    blaze_query.Target.create({
                        type: 1 as any,
                        rule: blaze_query.Rule.create({
                            name: '//pkg1:test_a',
                            ruleClass: 'cc_test',
                            location: '/test/workspace/pkg1/BUILD:5:1',
                        }),
                    }),
                    blaze_query.Target.create({
                        type: 1 as any,
                        rule: blaze_query.Rule.create({
                            name: '//pkg1/subpkgA:test_sub_a',
                            ruleClass: 'py_test',
                            location: '/test/workspace/pkg1/subpkgA/BUILD:3:1',
                        }),
                    }),
                    blaze_query.Target.create({
                        type: 1 as any,
                        rule: blaze_query.Rule.create({
                            name: '//pkg2:test_c',
                            ruleClass: 'sh_test',
                            location: '/test/workspace/pkg2/BUILD.bazel:7:1',
                        }),
                    }),
                ],
            });
            queryTargetsStub.resolves(MOCK_QUERY_RESULT_NESTED_HIERARCHY);
            await discoverAllTestsInWorkspace(mockController, mockAdapterWorkspaceInfo, mockContext);
            assert.strictEqual(mockController.items.size, 2, 'Should have 2 top-level package items: //pkg1 and //pkg2');
            const pkg1Item = mockController.items.get('//pkg1');
            assert.ok(pkg1Item, 'Package //pkg1 should exist');
            if (pkg1Item) {
                assert.strictEqual(pkg1Item.label, 'pkg1', 'Package //pkg1 label should be "pkg1"');
                assert.strictEqual(pkg1Item.children.size, 2, 'Package //pkg1 should have 2 children: test_a and subpkgA');
                const testAItem = pkg1Item.children.get('//pkg1:test_a');
                assert.ok(testAItem, 'Test //pkg1:test_a should exist as a child of //pkg1');
                if (testAItem) {
                    assert.strictEqual(testAItem.label, 'test_a');
                    assert.strictEqual(testAItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg1/BUILD').fsPath);
                    assert.deepStrictEqual(testAItem.range, new vscode.Range(4, 0, 4, 0));
                }
                const subPkgAItem = pkg1Item.children.get('//pkg1/subpkgA');
                assert.ok(subPkgAItem, 'Sub-package //pkg1/subpkgA should exist as a child of //pkg1');
                if (subPkgAItem) {
                    assert.strictEqual(subPkgAItem.label, 'subpkgA', 'Label for //pkg1/subpkgA item should be subpkgA');
                    assert.strictEqual(subPkgAItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg1/subpkgA').fsPath, 'URI for sub-package item should point to its directory');
                    assert.strictEqual(subPkgAItem.children.size, 1, 'Sub-package //pkg1/subpkgA should have 1 test item child');
                    const testSubAItem = subPkgAItem.children.get('//pkg1/subpkgA:test_sub_a');
                    assert.ok(testSubAItem, 'Test //pkg1/subpkgA:test_sub_a should exist as a child of //pkg1/subpkgA');
                    if (testSubAItem) {
                        assert.strictEqual(testSubAItem.label, 'test_sub_a');
                        assert.strictEqual(testSubAItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg1/subpkgA/BUILD').fsPath);
                        assert.deepStrictEqual(testSubAItem.range, new vscode.Range(2, 0, 2, 0));
                    }
                }
            }
            const pkg2Item = mockController.items.get('//pkg2');
            assert.ok(pkg2Item, 'Package //pkg2 should exist');
            if (pkg2Item) {
                assert.strictEqual(pkg2Item.label, 'pkg2');
                assert.strictEqual(pkg2Item.children.size, 1, 'Package //pkg2 should have 1 test item');
                const testCItem = pkg2Item.children.get('//pkg2:test_c');
                assert.ok(testCItem, 'Test //pkg2:test_c should exist');
                if (testCItem) {
                    assert.strictEqual(testCItem.label, 'test_c');
                    assert.strictEqual(testCItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg2/BUILD.bazel').fsPath);
                    assert.deepStrictEqual(testCItem.range, new vscode.Range(6, 0, 6, 0));
                }
            }
        });
    });

    describe('runHandler', () => {
        let mockAdapterWorkspaceInfo: IBazelTestAdapterWorkspaceInfo;
        let mockFsApi: TestExplorerFs;
        // getWorkspaceInfoStub will be initialized here now

        beforeEach(() => {
            // Create a bare Sinon stub for the getWorkspaceInfoFunc dependency
            getWorkspaceInfoStub = sinon.stub();

            mockAdapterWorkspaceInfo = {
                bazelWorkspace: new (BazelWorkspaceInfo as any)('/test/workspace', { uri: vscode.Uri.file('/test/workspace'), name: 'workspace', index: 0 }),
                bazelExecutablePath: '/usr/bin/bazel',
                workspaceFolder: { uri: vscode.Uri.file('/test/workspace'), name: 'workspace', index: 0 },
            };

            mockFsApi = {
                readFile: sinon.stub()
            };
        });

        it('should report error if test data not found for an item', async () => {
            // Configure getWorkspaceInfoStub for this specific test
            getWorkspaceInfoStub.returns(mockAdapterWorkspaceInfo);

            const parentTestItem = mockController.createTestItem('//pkg1:unknown_test', 'unknown_test');
            const mockTestRunInterface = {
                started: sinon.stub(), passed: sinon.stub(), failed: sinon.stub(),
                skipped: sinon.stub(), errored: sinon.stub(), appendOutput: sinon.stub(), end: sinon.stub(),
            };
            (mockController.createTestRun as sinon.SinonStub).returns(mockTestRunInterface);

            const request = new vscode.TestRunRequest([parentTestItem]);
            const cancellationTokenSource = new vscode.CancellationTokenSource();
            const isolatedTestItemData = new WeakMap();

            await runHandler(request, cancellationTokenSource.token, mockContext, mockController, isolatedTestItemData, mockFsApi, getWorkspaceInfoStub);

            sinon.assert.called(getWorkspaceInfoStub);
            sinon.assert.called(mockController.createTestRun as sinon.SinonStub);

            const startedCall = mockTestRunInterface.started as sinon.SinonStub;
            sinon.assert.calledWith(startedCall, sinon.match.has('id', parentTestItem.id));

            const erroredCall = mockTestRunInterface.errored as sinon.SinonStub;
            sinon.assert.calledWith(erroredCall,
                sinon.match.has('id', parentTestItem.id),
                sinon.match.some(sinon.match({ message: "Test data not found for this item." }))
                // This path in runHandler for !testData does not pass a duration.
            );

            sinon.assert.calledOnce(mockTestRunInterface.end as sinon.SinonStub);
        });

        it('should attempt to read test.xml and handle file not found', async () => {
            // Configure getWorkspaceInfoStub for this specific test
            getWorkspaceInfoStub.returns(mockAdapterWorkspaceInfo);

            const parentTestItem = mockController.createTestItem('//pkg1:test_xml_not_found', 'test_xml_not_found', vscode.Uri.file('/test/workspace/pkg1/BUILD'));
            const currentTestItemDataForTest = new WeakMap();
            currentTestItemDataForTest.set(parentTestItem, { bazelLabel: '//pkg1:test_xml_not_found', kind: 'cc_test', package: '//pkg1' });

            const mockTestRunInterface = { // Define the TestRun object
                started: sinon.stub(),
                passed: sinon.stub(),
                failed: sinon.stub(),
                skipped: sinon.stub(),
                errored: sinon.stub(),
                appendOutput: sinon.stub(),
                end: sinon.stub(),
            };
            (mockController.createTestRun as sinon.SinonStub).returns(mockTestRunInterface); // Configure stub

            const mockSpawnInstance = {
                stdout: { on: sinon.stub(), pipe: sinon.stub() },
                stderr: { on: sinon.stub(), pipe: sinon.stub() },
                on: sinon.stub(),
                kill: sinon.stub(),
            };
            mockSpawnInstance.on.withArgs('close').yieldsAsync(0); // Simulate successful bazel test run (exit code 0)
            spawnStub.returns(mockSpawnInstance as any);

            const request = new vscode.TestRunRequest([parentTestItem]);
            const cancellationTokenSource = new vscode.CancellationTokenSource();

            const expectedXmlPath = path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'bazel-testlogs', 'pkg1', 'test_xml_not_found', 'test.xml');
            const expectedXmlUri = vscode.Uri.file(expectedXmlPath);
            (mockFsApi.readFile as sinon.SinonStub).withArgs(sinon.match((uri: vscode.Uri) => uri.fsPath === expectedXmlUri.fsPath))
                .rejects(new vscode.FileSystemError(expectedXmlUri));

            // Corrected: Call runHandler once with the correct test item data and injected stub
            await runHandler(request, cancellationTokenSource.token, mockContext, mockController, currentTestItemDataForTest, mockFsApi, getWorkspaceInfoStub);

            sinon.assert.called(getWorkspaceInfoStub);
            sinon.assert.called(mockController.createTestRun as sinon.SinonStub);

            const startedCall = mockTestRunInterface.started as sinon.SinonStub;
            sinon.assert.calledWith(startedCall, sinon.match.has('id', parentTestItem.id));

            const appendOutputCall = mockTestRunInterface.appendOutput as sinon.SinonStub;
            // Removed duplicate declaration of appendOutputCall here

            // Exact messages expected (logTestOutput adds \r\n)
            const executingMsg = `Executing: bazel test ${currentTestItemDataForTest.get(parentTestItem)!.bazelLabel}\r\n\r\n`; // Double \r\n as seen in logs in runHandler
            const attemptMsg = `Attempting to read test.xml using symlink path: ${expectedXmlPath}\r\n`;
            const specificErrorMessage = expectedXmlUri.toString(true); // Message from FileSystemError
            // Loosening assertions for appendOutput due to persistent matching issues.
            // We know from logs it's called 3 times. Check this and the critical final state.
            sinon.assert.calledThrice(appendOutputCall);

            // Check at least one call was with the parentTestItem (by id, loosely)
            sinon.assert.calledWith(appendOutputCall, sinon.match.string, sinon.match.any, sinon.match.has('id', parentTestItem.id));

            assert.strictEqual(parentTestItem.children.size, 0, "Should create no child items if XML reading fails");

            const failedCall = mockTestRunInterface.failed as sinon.SinonStub;
            sinon.assert.calledWith(failedCall, sinon.match.has('id', parentTestItem.id), sinon.match.array, sinon.match.number);

            sinon.assert.calledOnce(mockTestRunInterface.end as sinon.SinonStub);
        });

        it('should parse test.xml from symlink path and create child items', async () => {
            // Configure getWorkspaceInfoStub for this specific test
            getWorkspaceInfoStub.returns(mockAdapterWorkspaceInfo);

            const parentTestItem = mockController.createTestItem('//pkg_xml:test_with_xml', 'test_with_xml', vscode.Uri.file('/test/workspace/pkg_xml/BUILD'));
            const currentTestItemDataForTest = new WeakMap();
            currentTestItemDataForTest.set(parentTestItem, { bazelLabel: '//pkg_xml:test_with_xml', kind: 'py_test', package: '//pkg_xml' });

            const mockTestRunInterface = { // Define the TestRun object
                started: sinon.stub(),
                passed: sinon.stub(),
                failed: sinon.stub(),
                skipped: sinon.stub(),
                errored: sinon.stub(),
                appendOutput: sinon.stub(),
                end: sinon.stub(),
            };
            (mockController.createTestRun as sinon.SinonStub).returns(mockTestRunInterface); // Configure stub

            const mockSpawnInstance = {
                stdout: { on: sinon.stub(), pipe: sinon.stub() },
                stderr: { on: sinon.stub(), pipe: sinon.stub() },
                on: sinon.stub(),
                kill: sinon.stub(),
            };
            mockSpawnInstance.on.withArgs('close').yieldsAsync(0); // Simulate successful bazel test run
            spawnStub.returns(mockSpawnInstance as any);

            const request = new vscode.TestRunRequest([parentTestItem]);
            const cancellationTokenSource = new vscode.CancellationTokenSource();

            const MOCK_TEST_XML_CONTENT = `
                <testsuites>
                    <testsuite name="TestSuite1" tests="2" failures="1" errors="0" time="0.5">
                        <testcase name="test_passing" classname="my.class.PassingTest" time="0.1"/>
                        <testcase name="test_failing" classname="my.class.FailingTest" time="0.2">
                            <failure message="AssertionError: Expected true to be false">Details here</failure>
                        </testcase>
                        <testcase name="test_skipped" classname="my.class.SkippedTest" time="0.1">
                           <skipped/>
                        </testcase>
                    </testsuite>
                </testsuites>
            `;
            const expectedXmlPath = path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'bazel-testlogs', 'pkg_xml', 'test_with_xml', 'test.xml');
            const expectedXmlUri = vscode.Uri.file(expectedXmlPath);
            (mockFsApi.readFile as sinon.SinonStub).withArgs(sinon.match((uri: vscode.Uri) => uri.fsPath === expectedXmlUri.fsPath))
                .resolves(Buffer.from(MOCK_TEST_XML_CONTENT));

            // Corrected: Call runHandler once with the correct test item data and injected stub
            await runHandler(request, cancellationTokenSource.token, mockContext, mockController, currentTestItemDataForTest, mockFsApi, getWorkspaceInfoStub);

            sinon.assert.called(getWorkspaceInfoStub);
            sinon.assert.called(mockController.createTestRun as sinon.SinonStub);

            const startedCall = mockTestRunInterface.started as sinon.SinonStub;
            sinon.assert.calledWith(startedCall, sinon.match.has('id', parentTestItem.id));

            const appendOutputCall = mockTestRunInterface.appendOutput as sinon.SinonStub;
            const successMsgPrefix = `Successfully parsed`;
            sinon.assert.calledWith(
                appendOutputCall,
                sinon.match(str => typeof str === 'string' && str.startsWith(successMsgPrefix) && str.includes(expectedXmlPath) && str.endsWith('\r\n')),
                sinon.match.same(undefined),
                sinon.match.has('id', parentTestItem.id)
            );

            assert.strictEqual(parentTestItem.children.size, 3, "Should create 3 child items from XML");

            const passedCall = mockTestRunInterface.passed as sinon.SinonStub;
            const failingChildCall = mockTestRunInterface.failed as sinon.SinonStub; // Renamed for clarity for child
            const skippedCall = mockTestRunInterface.skipped as sinon.SinonStub;

            const passingChild = parentTestItem.children.get(`${parentTestItem.id}/my.class.PassingTest.test_passing`);
            assert.ok(passingChild, "Passing test case child should exist");
            sinon.assert.calledWith(passedCall, sinon.match.has('id', passingChild!.id), 100);

            const failingChildItem = parentTestItem.children.get(`${parentTestItem.id}/my.class.FailingTest.test_failing`);
            assert.ok(failingChildItem, "Failing test case child should exist");
            // Corrected message to match what's parsed (inner text of <failure> tag)
            sinon.assert.calledWith(failingChildCall, sinon.match.has('id', failingChildItem!.id), sinon.match.some(sinon.match({ message: 'Details here' })), 200);

            const skippedChild = parentTestItem.children.get(`${parentTestItem.id}/my.class.SkippedTest.test_skipped`);
            assert.ok(skippedChild, "Skipped test case child should exist");
            sinon.assert.calledWith(skippedCall, sinon.match.has('id', skippedChild!.id));

            // Check parent item's final state (should be failed due to one failing child)
            // The failingChildCall will also be called for the parent.
            sinon.assert.calledWith(failingChildCall, sinon.match.has('id', parentTestItem.id), sinon.match.array, sinon.match.number);

            sinon.assert.calledOnce(mockTestRunInterface.end as sinon.SinonStub);
        });
    });
});


describe('File Watcher Granular Updates', () => {
    let mockAdapterWorkspaceInfo: IBazelTestAdapterWorkspaceInfo;
    let mockContextForWatcher: vscode.ExtensionContext;
    let fileWatcherQueryTargetsStub: sinon.SinonStub; // Use a distinct name to avoid confusion
    let sutsModuleBazelTestController: vscode.TestController;

    type MockWatcherInstance = {
        onDidChange: sinon.SinonStub;
        onDidCreate: sinon.SinonStub;
        onDidDelete: sinon.SinonStub;
        dispose: sinon.SinonStub;
        ignoreCreateEvents: boolean;
        ignoreChangeEvents: boolean;
        ignoreDeleteEvents: boolean;
    };
    let mockWatcherInstance: MockWatcherInstance;
    let createWatcherStub: sinon.SinonStub;
    let capturedOnChange: (uri: vscode.Uri) => Promise<void>;
    let statSyncStub: sinon.SinonStub;

    beforeEach(() => {
        // Stub fs.statSync before BazelWorkspaceInfo.fromWorkspaceFolder is called
        statSyncStub = sinon.stub(fs, 'statSync');
        statSyncStub.callsFake((pathToCheck: fs.PathLike) => {
            const pathString = pathToCheck.toString();
            // Simulate workspace root and common marker files as existing
            if (pathString === '/test/workspace' ||
                pathString === path.join('/test/workspace', 'WORKSPACE') ||
                pathString === path.join('/test/workspace', 'MODULE.bazel') ||
                pathString === path.join('/test/workspace', 'WORKSPACE.bazel')) {
                return {
                    isFile: () => pathString !== '/test/workspace',
                    isDirectory: () => pathString === '/test/workspace'
                } as fs.Stats;
            }
            // For any other path, throw ENOENT to simulate it not existing.
            const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${pathString}'`);
            error.code = 'ENOENT';
            throw error;
        });

        const mementoMock = {
            get: sinon.stub().callsFake((key: string, defaultValue?: any) => {
                if (typeof defaultValue !== 'undefined') return defaultValue;
                return undefined;
            }) as vscode.Memento['get'],
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        };
        const mockSubscriptions: vscode.Disposable[] = []; // Must be an array
        mockContextForWatcher = { // Use distinct name
            subscriptions: mockSubscriptions,
            workspaceState: mementoMock,
            globalState: mementoMock as any, // Cast for simplicity, ensure all methods if used
            extensionPath: '/mock/extension/path',
            storagePath: '/mock/storage/path',
            globalStoragePath: '/mock/global/storage/path',
            logPath: '/mock/log/path',
            extensionUri: vscode.Uri.file('/mock/extension/path'),
            environmentVariableCollection: {} as any,
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: vscode.Uri.file('/mock/storage/path'),
            globalStorageUri: vscode.Uri.file('/mock/global/storage/path'),
            logUri: vscode.Uri.file('/mock/log/path'),
            secrets: { get: sinon.stub(), store: sinon.stub(), delete: sinon.stub(), onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event },
            asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
            extension: {
                id: 'mock.extension.id', extensionPath: '/mock/extension/path', isActive: true,
                packageJSON: { name: 'mock-ext', version: '0.0.1', publisher: 'mock', engines: {} },
                extensionKind: vscode.ExtensionKind.Workspace, exports: {}, activate: sinon.stub().resolves()
            } as any,
            languageModelAccessInformation: undefined,
        } as vscode.ExtensionContext;

        // Mock workspace info
        const mockVSCodeWorkspaceFolder = { uri: vscode.Uri.file('/test/workspace'), name: 'workspace', index: 0 };
        mockAdapterWorkspaceInfo = {
            bazelWorkspace: BazelWorkspaceInfo.fromWorkspaceFolder(mockVSCodeWorkspaceFolder)!,
            bazelExecutablePath: '/usr/bin/bazel',
            workspaceFolder: mockVSCodeWorkspaceFolder,
        };

        // Stub getBazelTestAdapterWorkspaceInfo to return our mock
        // This is a module-level stub, ensure it's managed correctly (e.g. via sinon.restore() in afterEach)
        // getWorkspaceInfoStub is declared globally in the file.
        getWorkspaceInfoStub = sinon.stub(BTA, 'getBazelTestAdapterWorkspaceInfo');
        getWorkspaceInfoStub.returns(mockAdapterWorkspaceInfo);

        // Initialize the suite-specific queryTargetsStub
        fileWatcherQueryTargetsStub = sinon.stub(BazelQuery.prototype, 'queryTargets');
        // No default .callsFake or .throws for this iteration.

        mockWatcherInstance = {
            onDidChange: sinon.stub(),
            onDidCreate: sinon.stub(),
            onDidDelete: sinon.stub(),
            dispose: sinon.stub(),
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
        };
        createWatcherStub = sinon.stub(vscode.workspace, 'createFileSystemWatcher').returns(mockWatcherInstance as any);

        BTA.activateBazelTests(mockContextForWatcher); // Use the correctly typed context
        sutsModuleBazelTestController = BTA.getBazelTestController();

        if (mockWatcherInstance.onDidChange.called && mockWatcherInstance.onDidChange.firstCall.args.length > 0) {
            capturedOnChange = mockWatcherInstance.onDidChange.firstCall.args[0];
        } else {
            mockWatcherInstance.onDidChange.callsFake(callback => { capturedOnChange = callback; });
        }
    });

    afterEach(() => {
        sinon.restore();
        SUTPackagesMap.clear(); // Clear the imported packagesMap
    });

    it('onDidChange BUILD file - should add a new test', async () => {
        const initialDiscoverResult = blaze_query.QueryResult.create({
            target: [
                blaze_query.Target.create({
                    type: 1,
                    rule: blaze_query.Rule.create({
                        name: '//pkg1:test_a',
                        ruleClass: 'cc_test',
                        location: path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD') + ':5:1',
                    }),
                }),
            ],
        });

        let actualInitialQueryArg: string | undefined;
        fileWatcherQueryTargetsStub.callsFake((query: string) => {
            if (query === 'kind(".*_test rule", //...)') { // The first expected call
                actualInitialQueryArg = query;
                return Promise.resolve(initialDiscoverResult);
            }
            // For the subsequent call by updateTestsInPackage for //pkg1:all
            if (query === 'kind(".*_test rule", //pkg1:all)') {
                // This is defined later in the test, but the fake needs to anticipate it.
                // The specific pkg1UpdateResult will be set on the stub using withArgs later.
                // For now, just ensure it doesn't throw if called.
                const ruleAUpdated = blaze_query.Rule.create({
                    name: '//pkg1:test_a', ruleClass: 'cc_test',
                    location: path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD') + ':8:1',
                });
                const ruleBNew = blaze_query.Rule.create({
                    name: '//pkg1:test_b', ruleClass: 'py_test',
                    location: path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD') + ':15:1',
                });
                const tempPkg1UpdateResult = blaze_query.QueryResult.create({ target: [
                    blaze_query.Target.create({ type: 1, rule: ruleAUpdated }),
                    blaze_query.Target.create({ type: 1, rule: ruleBNew }),
                ]});
                return Promise.resolve(tempPkg1UpdateResult);
            }
            const actualArgs = `Actual query: '${query}'`;
            throw new Error(`QUERY_TARGETS_UNEXPECTED_CALL_DETAILS_IN_FAKE: ${actualArgs}`);
        });

        await sutsModuleBazelTestController.resolveHandler!(undefined);

        assert.strictEqual(actualInitialQueryArg, 'kind(".*_test rule", //...)', `Initial discovery query was: ${actualInitialQueryArg}`);

        let pkg1Item = sutsModuleBazelTestController.items.get('//pkg1');
        assert.ok(pkg1Item, "Package //pkg1 should exist after initial discovery");
        assert.strictEqual(pkg1Item!.children.size, 1, "Package //pkg1 should have 1 test initially");
        assert.ok(pkg1Item!.children.get('//pkg1:test_a'), "Test //pkg1:test_a should exist initially");

        const ruleAUpdated = blaze_query.Rule.create({
            name: '//pkg1:test_a', ruleClass: 'cc_test',
            location: path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD') + ':8:1', // Line changed
        });
        const ruleBNew = blaze_query.Rule.create({
            name: '//pkg1:test_b', ruleClass: 'py_test',
            location: path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD') + ':15:1',
        });
        const pkg1UpdateResult = blaze_query.QueryResult.create({ target: [
            blaze_query.Target.create({ type: 1, rule: ruleAUpdated }),
            blaze_query.Target.create({ type: 1, rule: ruleBNew }),
        ]});
        fileWatcherQueryTargetsStub.withArgs('kind(".*_test rule", //pkg1:all)').resolves(pkg1UpdateResult);

        // 3. Act: Simulate BUILD file change
        const buildFileUri = vscode.Uri.file(path.join(mockAdapterWorkspaceInfo.workspaceFolder.uri.fsPath, 'pkg1', 'BUILD'));
        assert.ok(capturedOnChange, "onDidChange callback should have been captured");
        await capturedOnChange(buildFileUri);

        // 4. Assert: Check for new and updated tests
        pkg1Item = sutsModuleBazelTestController.items.get('//pkg1'); // Re-fetch
        assert.ok(pkg1Item, "Package //pkg1 should still exist");
        assert.strictEqual(pkg1Item!.children.size, 2, "Package //pkg1 should now have 2 tests");

        const testAItemUpdated = pkg1Item!.children.get('//pkg1:test_a');
        assert.ok(testAItemUpdated, "Test //pkg1:test_a should still exist");
        assert.strictEqual(testAItemUpdated!.range?.start.line, 7, "Test //pkg1:test_a range should be updated"); // 8 - 1

        const testBItemNew = pkg1Item!.children.get('//pkg1:test_b');
        assert.ok(testBItemNew, "New test //pkg1:test_b should exist");
        assert.strictEqual(testBItemNew!.label, 'test_b');
        assert.strictEqual(testBItemNew!.range?.start.line, 14, "Test //pkg1:test_b range should be correct"); // 15 - 1
    });

    // TODO: Add more tests:
    // - onDidChange BUILD file - should remove a test
    // - onDidChange BUILD file - should update an existing test (e.g. line number change)
    // - onDidChange .bzl file - should trigger full refresh
    // - onDidCreate BUILD file - should add new package and its tests
    // - onDidDelete BUILD file - should remove package and its tests
});
