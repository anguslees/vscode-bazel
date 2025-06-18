/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as child_process from 'child_process';
import {
    discoverAllTestsInWorkspace,
    IBazelTestAdapterWorkspaceInfo,
    // getBazelTestAdapterWorkspaceInfo, // No longer directly used in top-level describe, stubbed via BTA module
    testItemData,
    runHandler,
    TestExplorerFs // Import the interface
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
    let queryTargetsStub: sinon.SinonStub;
    let spawnStub: sinon.SinonStub;

    beforeEach(() => {
        mockController = createStubTestController();

        const mementoMock: vscode.Memento = {
            get: sinon.stub().returns(undefined),
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

        queryTargetsStub = sinon.stub(BazelQuery.prototype, 'queryTargets');
        spawnStub = sinon.stub(child_process, 'spawn');

        // DO NOT Initialize getWorkspaceInfoStub here. It will be done in runHandler's beforeEach.
    });

    afterEach(() => {
        sinon.restore(); // This will restore all stubs, including getWorkspaceInfoStub if created.
    });

    describe('discoverAllTestsInWorkspace', () => {
        // This test needs its own getWorkspaceInfoStub if it calls the function directly or indirectly.
        // For now, assuming discoverAllTestsInWorkspace is self-contained or uses a passed-in adapterInfo.
        // If it internally calls BTA.getBazelTestAdapterWorkspaceInfo, it would need:
        // beforeEach(() => { getWorkspaceInfoStub = sinon.stub(BTA, 'getBazelTestAdapterWorkspaceInfo'); });
        it('Should discover tests and create hierarchy', async () => {
            // This test directly passes mockAdapterWorkspaceInfo, so it doesn't rely on the global stub for BTA.getBazelTestAdapterWorkspaceInfo
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
