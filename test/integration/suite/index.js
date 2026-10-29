'use strict';

const fs = require('fs');
const path = require('path');
const { Mocha } = require('mocha');

function run() {
    // MOCHA_GREP=pattern runs only the matching tests.
    const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120000, grep: process.env.MOCHA_GREP });
    for (const file of fs.readdirSync(__dirname)) {
        if (file.endsWith('.test.js')) mocha.addFile(path.join(__dirname, file));
    }
    return new Promise((resolve, reject) => {
        mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
    });
}

module.exports = { run };
