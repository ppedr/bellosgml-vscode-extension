'use strict';

// Downloads VS Code (cached in .vscode-test/) and runs the integration suite
// inside it with this extension loaded and every other extension disabled.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.join(__dirname, '..', '..');
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
            launchArgs: [path.join(root, 'test', 'fixtures', 'integration'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
        });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

main();
