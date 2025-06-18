import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../../'); // Resolves to project root from out/test

        // The path to the compiled test runner script.
        // __dirname will be out/test, so this resolves to out/test/index.js
        const extensionTestsPath = path.resolve(__dirname, './index.js');

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // launchArgs: ['--some-launch-arg'] // Example if needed
        });
    } catch (err) {
        console.error('Failed to run tests');
        console.error(err);
        process.exit(1);
    }
}

main();
