import {
  Agent,
  AgentCapability,
  AgentPolicy,
  AgentPolicyOverrides,
  AgentProfile,
} from './types.js';

const BASE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'mcp__nanoclaw__*',
];

const POWER_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'Skill',
  'ToolSearch',
  'NotebookEdit',
];

const ALL_TOOLS = [...BASE_TOOLS, ...POWER_TOOLS];

function capabilitiesForProfile(
  profile: AgentProfile,
): Record<AgentCapability, boolean> {
  switch (profile) {
    case 'admin':
      return {
        admin: true,
        remoteControl: true,
        crossAgentTaskTargeting: true,
        configureMounts: true,
        opencode: true,
      };
    case 'adult':
      return {
        admin: false,
        remoteControl: false,
        crossAgentTaskTargeting: false,
        configureMounts: false,
        opencode: true,
      };
    case 'child':
      return {
        admin: false,
        remoteControl: false,
        crossAgentTaskTargeting: false,
        configureMounts: false,
        opencode: false,
      };
  }
}

function toolsForProfile(profile: AgentProfile): string[] {
  if (profile === 'child') return BASE_TOOLS;
  return ALL_TOOLS;
}

export function resolveAgentPolicy(
  agent: Pick<Agent, 'profile' | 'policyOverrides' | 'isAdmin'>,
): AgentPolicy {
  const profile = agent.isAdmin ? 'admin' : agent.profile;
  const overrides: AgentPolicyOverrides = agent.policyOverrides || {};
  const capabilities = {
    ...capabilitiesForProfile(profile),
    ...(overrides.capabilities || {}),
  };

  const allowedTools = Array.from(
    new Set([
      ...toolsForProfile(profile),
      ...(overrides.allowedTools || []),
      ...(capabilities.opencode ? ['opencode'] : []),
    ]),
  );
  const disallowedTools = Array.from(
    new Set(overrides.disallowedTools || []),
  );

  return {
    profile,
    allowedTools: allowedTools.filter((tool) => !disallowedTools.includes(tool)),
    disallowedTools,
    capabilities,
  };
}

export function canAdmin(agent: Pick<Agent, 'profile' | 'policyOverrides' | 'isAdmin'>): boolean {
  return resolveAgentPolicy(agent).capabilities.admin;
}

export function canRemoteControl(
  agent: Pick<Agent, 'profile' | 'policyOverrides' | 'isAdmin'>,
): boolean {
  return resolveAgentPolicy(agent).capabilities.remoteControl;
}

export function canTargetOtherAgents(
  agent: Pick<Agent, 'profile' | 'policyOverrides' | 'isAdmin'>,
): boolean {
  return resolveAgentPolicy(agent).capabilities.crossAgentTaskTargeting;
}

export function canConfigureMounts(
  agent: Pick<Agent, 'profile' | 'policyOverrides' | 'isAdmin'>,
): boolean {
  return resolveAgentPolicy(agent).capabilities.configureMounts;
}
