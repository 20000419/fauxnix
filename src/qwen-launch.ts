import type { McpLaunchTuple } from './mcp-launch.js';
import { resolveMcpLaunchTuple, sameMcpLaunchTuple } from './mcp-launch.js';

export type QwenLaunchTuple = McpLaunchTuple;

// The Qwen launcher pioneered the absolute spawn-safe tuple; every harness
// now uses it (#252). These aliases keep the historical import surface.
export const resolveQwenLaunchTuple = resolveMcpLaunchTuple;
export const sameQwenLaunchTuple = sameMcpLaunchTuple;
