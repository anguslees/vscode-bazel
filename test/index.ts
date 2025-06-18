// test/index.ts
import * as path from 'path';
import * as Mocha from 'mocha';
import * as glob from 'glob';

export function run(testsRoot: string, cb: (error: any, failures?: number) => void): void {
    console.log('Initializing Mocha programmatically.');
    // The testsRoot provided by @vscode/test-electron's runner is the path to this index.js file.
    // We need the directory containing this file to correctly glob for other test files.
    const actualTestsRoot = path.dirname(testsRoot);
    console.log(`Actual test root directory (derived): ${actualTestsRoot}`);


    // Create the mocha test
    const mocha = new Mocha({
        ui: 'bdd', // Use BDD interface so 'describe', 'it', etc. are available
        color: true,
        timeout: 15000,
        reporter: 'spec'
    });

    // Find all test files (assuming .test.js pattern in the compiled output)
    let testFiles: string[];
    try {
        testFiles = glob.sync('**/*.test.js', { cwd: actualTestsRoot }); // Use actualTestsRoot for cwd
        console.log(`Found test files via glob: ${JSON.stringify(testFiles, null, 2)}`);
    } catch (err) {
        console.error('Error finding test files with glob:', err);
        cb(err);
        return;
    }

    // Add test files to the Mocha instance
    if (testFiles.length === 0) {
        console.warn('No test files found by glob in specified directory. Check glob pattern and actualTestsRoot.');
    }

    testFiles.forEach(f => {
        // Exclude runTest.js and index.js itself from being added as test files
        // This check should be against the simple filename `f`, not the resolved path.
        if (f === 'runTest.js' || f === 'index.js') {
            console.log(`Skipping adding self/runner to Mocha: ${f}`);
            return;
        }
        const filePath = path.resolve(actualTestsRoot, f); // Use actualTestsRoot for resolving
        console.log(`Adding file to Mocha: ${filePath}`);
        mocha.addFile(filePath);
    });

    try {
        console.log('Running Mocha tests...');
        // Run the tests.
        mocha.run(failures => {
            console.log(`Mocha run completed. Failures: ${failures}`);
            cb(null, failures);
        });
    } catch (err) {
        console.error('Error running tests with Mocha programmatically:', err);
        cb(err);
    }
}
