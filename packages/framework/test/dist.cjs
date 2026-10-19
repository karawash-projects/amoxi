// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Framework tests load the compiled output. AMOXI_DIST points at another build directory
// (used when several builds run side by side); the default is packages/framework/dist.
const path = require('node:path');

const DIST = process.env.AMOXI_DIST ? path.resolve(process.env.AMOXI_DIST) : path.join(__dirname, '..', 'dist');

/** require() a compiled module by its path under src/, e.g. load('ai/models/offline'). */
exports.load = (modulePath) => require(path.join(DIST, modulePath));
exports.DIST = DIST;
