#!/usr/bin/env node
'use strict';
require('../src/cli').main().then(code => { process.exitCode = code; }).catch(error => {
  console.error('mtool-embed: ' + error.message);
  process.exitCode = 1;
});
