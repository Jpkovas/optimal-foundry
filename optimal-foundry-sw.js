/*
 * Optimal Foundry bridge. Copy this file, unchanged, to the root of the Foundry user Data folder (next to the
 * "modules" and "worlds" folders), once. It only loads the module's real worker, which a browser accepts for the
 * whole site only from a script at the root; module updates then reach every browser without a new copy.
 */
importScripts("modules/optimal-foundry/sw.js");
