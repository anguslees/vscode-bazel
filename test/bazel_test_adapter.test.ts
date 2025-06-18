import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { discoverAllTestsInWorkspace, IBazelTestAdapterWorkspaceInfo } from '../src/test-explorer/bazel_test_adapter';
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
        createRunProfile: sinon.stub().returns({ dispose: sinon.stub() } as any),
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
        refreshHandler: undefined, // Can be undefined if not used by the code under test
        invalidateTestResults: sinon.stub(), // Stub if it might be called
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
        forEach: (callback: (item: vscode.TestItem) => void) => itemsMap.forEach(callback), // Corrected
        get size() { return itemsMap.size; }
    } as any;
    return collection;
}


suite('Bazel Test Adapter Tests', () => {
    let mockController: vscode.TestController;
    let mockContext: vscode.ExtensionContext;
    let queryTargetsStub: sinon.SinonStub;

    setup(() => {
        mockController = createStubTestController();

        const mementoMock: vscode.Memento = {
            get: sinon.stub().returns(undefined),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        };

        mockContext = {
            subscriptions: [],
            workspaceState: mementoMock,
            globalState: { ...mementoMock, setKeysForSync: sinon.stub() } as any, // Cast for setKeysForSync
            extensionPath: '/mock/extension/path',
            storagePath: '/mock/storage/path', // Deprecated, use storageUri
            globalStoragePath: '/mock/global/storage/path', // Deprecated, use globalStorageUri
            logPath: '/mock/log/path', // Deprecated, use logUri
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
            } as any, // Cast to any for simplicity of mock
            languageModelAccessInformation: undefined, // Add missing property
        } as vscode.ExtensionContext;

        queryTargetsStub = sinon.stub(BazelQuery.prototype, 'queryTargets');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Should discover tests and create hierarchy', async () => {
        // Arrange
        const mockVSCodeWorkspaceFolder = { uri: vscode.Uri.file('/test/workspace'), name: 'workspace', index: 0 };

        // Create a BazelWorkspaceInfo instance using the private constructor via 'as any' for testing purposes.
        // This is because its static factory methods might involve file system checks we want to avoid in this unit test.
        const bazelWorkspaceInstance = new (BazelWorkspaceInfo as any)('/test/workspace', mockVSCodeWorkspaceFolder);

        const mockAdapterWorkspaceInfo: IBazelTestAdapterWorkspaceInfo = {
            bazelWorkspace: bazelWorkspaceInstance, // This is the instance of BazelWorkspaceInfo
            bazelExecutablePath: '/usr/bin/bazel',
            workspaceFolder: mockVSCodeWorkspaceFolder,
        };

        const MOCK_QUERY_RESULT_HIERARCHY = blaze_query.QueryResult.create({
            target: [
                blaze_query.Target.create({
                    type: 1 as any, // Assuming 1 is RULE, cast as any for mock
                    rule: blaze_query.Rule.create({
                        name: '//pkg1:test_a',
                        ruleClass: 'cc_test',
                        location: '/test/workspace/pkg1/BUILD:5:1',
                    }),
                }),
                blaze_query.Target.create({
                    type: 1 as any, // Assuming 1 is RULE
                    rule: blaze_query.Rule.create({
                        name: '//pkg1:test_b',
                        ruleClass: 'py_test',
                        location: '/test/workspace/pkg1/BUILD:12:1',
                    }),
                }),
                blaze_query.Target.create({
                    type: 1 as any, // Assuming 1 is RULE
                    rule: blaze_query.Rule.create({
                        name: '//pkg2:test_c',
                        ruleClass: 'sh_test',
                        location: '/test/workspace/pkg2/BUILD.bazel:3:1',
                    }),
                }),
            ],
        });
        queryTargetsStub.resolves(MOCK_QUERY_RESULT_HIERARCHY);

        // Act
        await discoverAllTestsInWorkspace(mockController, mockAdapterWorkspaceInfo, mockContext);

        // Assert
        assert.strictEqual(mockController.items.size, 2, 'Should have 2 package items');

        const pkg1Item = mockController.items.get('//pkg1');
        assert.ok(pkg1Item, 'Package //pkg1 should exist');
        if (pkg1Item) {
            assert.strictEqual(pkg1Item.label, 'pkg1', 'Package //pkg1 label should be "pkg1"');
            assert.strictEqual(pkg1Item.children.size, 2, 'Package //pkg1 should have 2 test items');

            const testAItem = pkg1Item.children.get('//pkg1:test_a');
            assert.ok(testAItem, 'Test //pkg1:test_a should exist');
            if (testAItem) {
                assert.strictEqual(testAItem.label, 'test_a', 'Label for test_a should be "test_a"');
                assert.strictEqual(testAItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg1/BUILD').fsPath, 'URI for test_a should point to its BUILD file');
                assert.deepStrictEqual(testAItem.range, new vscode.Range(4, 0, 4, 0), 'Range for test_a incorrect (line 5:1 -> 0-indexed 4, char 0)');
            }

            const testBItem = pkg1Item.children.get('//pkg1:test_b');
            assert.ok(testBItem, 'Test //pkg1:test_b should exist');
            if (testBItem) {
                assert.strictEqual(testBItem.label, 'test_b', 'Label for test_b should be "test_b"');
                assert.strictEqual(testBItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg1/BUILD').fsPath, 'URI for test_b should point to its BUILD file');
                assert.deepStrictEqual(testBItem.range, new vscode.Range(11, 0, 11, 0), 'Range for test_b incorrect (line 12:1 -> 0-indexed 11, char 0)');
            }
        }

        const pkg2Item = mockController.items.get('//pkg2');
        assert.ok(pkg2Item, 'Package //pkg2 should exist');
        if (pkg2Item) {
            assert.strictEqual(pkg2Item.label, 'pkg2', 'Package //pkg2 label should be "pkg2"');
            assert.strictEqual(pkg2Item.children.size, 1, 'Package //pkg2 should have 1 test item');

            const testCItem = pkg2Item.children.get('//pkg2:test_c');
            assert.ok(testCItem, 'Test //pkg2:test_c should exist');
            if (testCItem) {
                assert.strictEqual(testCItem.label, 'test_c', 'Label for test_c should be "test_c"');
                assert.strictEqual(testCItem.uri?.fsPath, vscode.Uri.file('/test/workspace/pkg2/BUILD.bazel').fsPath, 'URI for test_c should point to its BUILD.bazel file');
                assert.deepStrictEqual(testCItem.range, new vscode.Range(2, 0, 2, 0), 'Range for test_c incorrect (line 3:1 -> 0-indexed 2, char 0)');
            }
        }
    });
});
