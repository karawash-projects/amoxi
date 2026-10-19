// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { agents } from './agents.mjs';
import { build, supplyChain, unit } from './build.mjs';
import { e2e } from './e2e.mjs';
import { exportStage, performanceStage } from './misc.mjs';
import { packaging, scaffold } from './package.mjs';
import { production } from './production.mjs';
import { loadStage, recovery } from './resilience.mjs';
import { security } from './security.mjs';
import { environment, hygiene } from './static.mjs';

/** In run order. `quick: true` stages make up `npm run verify -- --quick`. */
export const STAGES = [environment, hygiene, supplyChain, build, unit, packaging, production, security, agents, exportStage, scaffold, loadStage, recovery, performanceStage, e2e];
