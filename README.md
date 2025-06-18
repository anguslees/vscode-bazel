# Bazel plugin for Visual Studio Code

[![Build Status](https://badge.buildkite.com/ecab448484315779ec28a95f8501b7f77a9a2abfc787037d5e.svg?branch=master)](https://buildkite.com/bazel/vscode-bazel-vs-bazel)

This extension provides support for Bazel in Visual Studio.

## Features

- Syntax highlighting
- **Bazel Targets** tree displays the build packages/targets in your
  workspace
- **CodeLens** links in BUILD files to directly launch a build or test by simply
  clicking on the targets
- **Buildifier** integration to lint and format your Bazel files (requires that
  [Buildifier](https://github.com/bazelbuild/buildtools/releases) be installed)
- **Bazel Task** definitions for `tasks.json`
- **Coverage Support** showing coverage results from `bazel coverage` directly
  in VS Code.
- Debug Starlark code in your `.bzl` files during a build (set breakpoints, step
  through code, inspect variables, etc.)

## Configuring the Extension

This extension adds a **Bazel** section to the extension settings in Visual
Studio Code. If you have Bazel installed in a location that is not on your
system path or if you wish to use a different version in the IDE, you should
set the **Bazel: Executable** setting to the location of the Bazel executable.

Similarly, the **Bazel: Buildifier Executable** setting can be configured if
you install Buildifier in a location that is not on your system path.

When Buildifier is installed, the **Format Document** command in Visual Studio
code will reformat `BUILD`, `WORKSPACE`, `.bzl`, and `.sky` files using the
tool and will display lint warnings from those files as you type. By default,
this extension does not automatically _fix_ lint warnings during formatting,
but you can opt into this by enabling the **Bazel: Buildifier Fix on Format**
setting.

### Using a separate output base

By default this extension will use the default output base for running queries. This will cause builds to block queries, potentially causing degraded performance. In Bazel versions since 7.1 it is safe to disable this by changing the `bazel.queriesShareServer` setting to `false`. In earlier versions it can be safely disabled after adding the convenience symlinks to `.bazelignore`, for example:

```
bazel-myreponame
bazel-bin
bazel-testlogs
```

See [#216](https://github.com/bazelbuild/vscode-bazel/issues/216) and [bazelbuild/bazel#106539](https://github.com/bazelbuild/bazel/issues/10653).

## Using the Starlark Debugger

Currently, the Starlark Debugger can be used by right-clicking a build target in
the **Bazel Build Targets** view and selecting "Build Target with Starlark
Debugger". This will start the build inside the Visual Studio Code debugger
(output will be redirected to the Debug Console pane) and it will pause on any
breakpoints hit during execution.

When a Bazel thread is paused, you can step through Starlark code, add watch
expressions, and execute arbitrary statements by typing them in the input area
of the Debug Console.

Clicking the "Stop" button in the debugger will kill the Bazel process being
debugger, allowing you to halt the current build. The Bazel server, however,
will continue running.

## Using a language server (experimental)

This extension can use a language server for various features, such as go to definition and completions. There are currently two compatible language servers:

- [bazel-lsp](https://github.com/cameron-martin/bazel-lsp) is based on Facebook's Starlark language server and extends it with additional, Bazel-specific functionality.
- [starpls](https://github.com/withered-magic/starpls) is an implementation based on rust-analyzer which also provides Bazel-specific functionality.

In general, you need to install the language server binary and then set the `bazel.lsp.command` setting. See the README of the corresponding repo for more specific setup instructions.

We can't currently make any recommendation between these two. Both are under active development and are rapidly gaining more functionality.

## Bazel tasks

Bazel tasks can be configured from the `tasks.json` using the following structure:

```jsonc
{
  // See https://go.microsoft.com/fwlink/?LinkId=733558
  // for the documentation about the tasks.json format
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Check for flakyness",
      "type": "bazel",
      "command": "test",
      "targets": ["${input:pickFlakyTest}"],
      "options": ["--runs_per_test=9"],
    },
  ],
  "inputs": [
    {
      "id": "pickFlakyTest",
      "type": "command",
      "command": "bazel.pickTarget",
      "args": {
        "query": "kind('.*_test', //...:*)",
        "placeHolder": "Which test to check for flakyness?",
      },
    },
  ],
}
```

## Test Explorer Integration

This extension integrates with VS Code's native Test Explorer, allowing you to discover, run, and (soon) debug your Bazel tests directly from the Test UI.

### Features:
- **Test Discovery**: Bazel test targets (e.g., `cc_test`, `py_test`, `sh_test`) defined in your `BUILD` and `BUILD.bazel` files are automatically discovered and displayed in the Test Explorer view. Tests are organized hierarchically by their Bazel package.
- **Run Tests**:
  - Click the run icon next to a test target or package in the Test Explorer to execute it.
  - Output from `bazel test` is streamed to the VS Code output panel for that test run.
  - Results are shown for individual test cases within a target (e.g., methods in a test class) by parsing the `test.xml` output.
- **View Test Source**: Click on a test target in the explorer to navigate to its definition in the corresponding BUILD file.
- **Automatic Updates**: The test list automatically refreshes if you create, delete, or modify BUILD or relevant `.bzl` files.
- **Configuration**: Test execution respects your configured Bazel command-line options, such as `bazel.commandLine.startupOptions` and `bazel.commandLine.commandArgs`.

### Debugging Tests (Proof-of-Concept):
- Basic debugging support is available for `py_test` targets.
- Select a single Python test target and click the "Debug" icon next to it in the Test Explorer.
- This will attempt to launch the test under `debugpy` and attach the VS Code Python debugger.
- **Note**: This is an early feature. Path mappings might need adjustment, and support for other languages will be added progressively. Ensure your Python environment and `rules_python` are configured to allow `debugpy` to listen on a port.

### Known Limitations:
- Debugging support is currently limited to Python tests and is considered experimental.
- While `test.xml` parsing provides detailed results for many common test types, very complex test structures or custom test runners might not be fully represented.

## Coverage support (Experimental)

For all `coverage` tasks, the coverage results are automatically loaded into VS
Code upon completion of the task. E.g., you could define your own task to
display the coverage provided by your integration tests using the following task
definition:

```jsonc
{
  "label": "Show test coverage from integration test",
  "type": "bazel",
  "command": "coverage",
  "targets": ["//test/integration/...", "//cpp/test/integration/..."],
  "options": ["--instrumentation_filter=.*"],
}
```

You might need additional Bazel `options` to get the intended coverage results.
In particular if are using remote builds, you might need to use the
`--experimental_split_coverage_postprocessing` and `--experimental_fetch_all_coverage_outputs`
options. See the documentation on [Code Coverage with Bazel](https://bazel.build/configure/coverage)
for more details.

Code coverage support in this extension is still rather fresh and might still
have rough edges. It was tested with the Java, C++, Go and Rust rules.
In case you are using the code coverage integration with any other language
(Python, Swift, Kotlin, Scala, ...), please let us know how things are going in
bazelbuild/vscode-bazel#367. Please share both positive and negative experiences
you might have.

For C++ and Rust, make sure to have `c++filt` / `rustfilt` installed and
available through the `$PATH`. Otherwise, only mangled, hard-to-decipher
function names will be displayed. For Java, no additional steps are required.

## Contributing

If you would like to contribute to the Bazel Visual Studio extension, please
refer to the [contribution guidelines](CONTRIBUTING.md) for information about
our patch acceptance process and setting up your development environment.
