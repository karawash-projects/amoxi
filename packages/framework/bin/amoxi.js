#!/usr/bin/env node
// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

// Stable launcher: exists before the first build, so npm can create the `amoxi`
// command shim (amoxi.cmd / amoxi.ps1 on Windows) at install time.
require('../dist/compiler/cli.js');
