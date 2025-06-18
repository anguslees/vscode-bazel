/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
// No explicit Mocha imports - rely on globals from test runner
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


describe('Bazel Test Adapter Tests', () => { // Using describe
    let mockController: vscode.TestController;
    let mockContext: vscode.ExtensionContext;
    let queryTargetsStub: sinon.SinonStub;

    beforeEach(() => { // Using beforeEach
        mockController = createStubTestController();

        const mementoMock: vscode.Memento = {
            get: sinon.stub().returns(undefined),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        };

        mockContext = {
            subscriptions: [],
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
    });

    afterEach(() => { // Using afterEach
        sinon.restore();
    });

    it('Should discover tests and create hierarchy', async () => { // Using it
        // Arrange
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
                    type: 1 as any, // RULE
                    rule: blaze_query.Rule.create({
                        name: '//pkg1:test_a',
                        ruleClass: 'cc_test',
                        location: '/test/workspace/pkg1/BUILD:5:1',
                    }),
                }),
                blaze_query.Target.create({
                    type: 1 as any, // RULE
                    rule: blaze_query.Rule.create({
                        name: '//pkg1/subpkgA:test_sub_a',
                        ruleClass: 'py_test',
                        location: '/test/workspace/pkg1/subpkgA/BUILD:3:1',
                    }),
                }),
                blaze_query.Target.create({
                    type: 1 as any, // RULE
                    rule: blaze_query.Rule.create({
                        name: '//pkg2:test_c',
                        ruleClass: 'sh_test',
                        location: '/test/workspace/pkg2/BUILD.bazel:7:1',
                    }),
                }),
            ],
        });
        queryTargetsStub.resolves(MOCK_QUERY_RESULT_NESTED_HIERARCHY);

        // Act
        await discoverAllTestsInWorkspace(mockController, mockAdapterWorkspaceInfo, mockContext);

        // Assert
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
                    assert.deepStrictEqual(testSubAItem.range, new vscode.Range(2, 0, 2, 0)); // Line 3:1
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
                assert.deepStrictEqual(testCItem.range, new vscode.Range(6, 0, 6, 0)); // Line 7:1
            }
        }
    });
});
