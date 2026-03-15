import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { canAdmin, canTargetOtherAgents } from './policy.js';
import { Agent, IdentityBinding, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  agents?: () => Record<string, Agent>;
  identityBindings?: () => Record<string, IdentityBinding>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  setAgent?: (agent: Agent) => void;
  setIdentityBinding?: (binding: IdentityBinding) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

function legacyAgentsFromGroups(
  groups: Record<string, RegisteredGroup>,
): Record<string, Agent> {
  const result: Record<string, Agent> = {};
  for (const group of Object.values(groups)) {
    result[group.folder] = {
      id: group.folder,
      slug: group.folder,
      displayName: group.name,
      workspaceFolder: group.folder,
      profile: group.isMain ? 'admin' : 'adult',
      policyOverrides: undefined,
      containerConfig: group.containerConfig,
      isAdmin: group.isMain === true,
      createdAt: group.added_at,
      status: 'active',
    };
  }
  return result;
}

function legacyBindingsFromGroups(
  groups: Record<string, RegisteredGroup>,
): Record<string, IdentityBinding> {
  const result: Record<string, IdentityBinding> = {};
  for (const [jid, group] of Object.entries(groups)) {
    result[jid] = {
      chatJid: jid,
      channel: 'unknown',
      agentId: group.folder,
      kind: 'group',
      createdAt: group.added_at,
      enabled: true,
      requiresTrigger: group.requiresTrigger,
      isAdmin: group.isMain === true,
    };
  }
  return result;
}

function getDefaultDeliveryChat(
  bindings: Record<string, IdentityBinding>,
  agentId: string,
): string {
  const binding = Object.values(bindings).find(
    (item) => item.agentId === agentId && item.enabled,
  );
  if (!binding) {
    throw new Error(`No enabled delivery chat for agent ${agentId}`);
  }
  return binding.chatJid;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const agents = deps.agents?.() || legacyAgentsFromGroups(registeredGroups);
    const bindings =
      deps.identityBindings?.() || legacyBindingsFromGroups(registeredGroups);

    // Build agentId→isAdmin lookup.
    const folderIsMain = new Map<string, boolean>();
    for (const agent of Object.values(agents)) {
      if (agent.isAdmin) folderIsMain.set(agent.id, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                const targetBinding = bindings[data.chatJid];
                if (
                  isMain ||
                  (targetBinding && targetBinding.agentId === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    targetAgentId?: string;
    deliveryChatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For create/update agent
    agentId?: string;
    slug?: string;
    displayName?: string;
    workspaceFolder?: string;
    profile?: Agent['profile'];
    policyOverrides?: Agent['policyOverrides'];
    status?: Agent['status'];
    enabled?: boolean;
    kind?: IdentityBinding['kind'];
    channel?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const agents = deps.agents?.() || legacyAgentsFromGroups(registeredGroups);
  const bindings =
    deps.identityBindings?.() || legacyBindingsFromGroups(registeredGroups);
  const sourceAgent = agents[sourceGroup];
  const isAdmin = sourceAgent ? canAdmin(sourceAgent) : isMain;
  const canTargetOther = sourceAgent
    ? canTargetOtherAgents(sourceAgent)
    : isMain;

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        (data.targetJid || data.targetAgentId)
      ) {
        const targetJid = data.targetJid as string | undefined;
        const targetBinding = targetJid ? bindings[targetJid] : undefined;
        const targetAgentId = data.targetAgentId || targetBinding?.agentId;
        const targetAgent = targetAgentId ? agents[targetAgentId] : undefined;
        if (!targetAgent) {
          logger.warn(
            { targetJid, targetAgentId },
            'Cannot schedule task: target agent not registered',
          );
          break;
        }

        // Non-admin agents can only schedule for themselves.
        if (!canTargetOther && targetAgent.id !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetAgentId: targetAgent.id },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          agent_id: targetAgent.id,
          delivery_chat_jid:
            data.deliveryChatJid ||
            targetJid ||
            getDefaultDeliveryChat(bindings, targetAgent.id),
          group_folder: targetAgent.workspaceFolder,
          chat_jid:
            targetJid || getDefaultDeliveryChat(bindings, targetAgent.id),
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetAgentId: targetAgent.id, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdmin || task.agent_id === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdmin || task.agent_id === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdmin || task.agent_id === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isAdmin && task.agent_id !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      if (isAdmin) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(bindings)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'create_agent':
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_agent attempt blocked',
        );
        break;
      }
      if (
        data.agentId &&
        data.slug &&
        data.displayName &&
        data.workspaceFolder &&
        isValidGroupFolder(data.agentId) &&
        isValidGroupFolder(data.workspaceFolder) &&
        deps.setAgent
      ) {
        deps.setAgent({
          id: data.agentId,
          slug: data.slug,
          displayName: data.displayName,
          workspaceFolder: data.workspaceFolder,
          profile: data.profile || 'adult',
          policyOverrides: data.policyOverrides,
          containerConfig: undefined,
          isAdmin: data.profile === 'admin',
          createdAt: new Date().toISOString(),
          status: data.status || 'active',
        });
      } else {
        logger.warn({ data }, 'Invalid create_agent request');
      }
      break;

    case 'bind_identity':
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized bind_identity attempt blocked',
        );
        break;
      }
      if (data.chatJid && data.agentId && deps.setIdentityBinding) {
        if (!agents[data.agentId]) {
          logger.warn(
            { agentId: data.agentId },
            'Agent not found for bind_identity',
          );
          break;
        }
        deps.setIdentityBinding({
          chatJid: data.chatJid,
          channel: data.channel || 'unknown',
          agentId: data.agentId,
          kind: data.kind || 'private',
          createdAt: new Date().toISOString(),
          enabled: data.enabled !== false,
          requiresTrigger: data.requiresTrigger,
          isAdmin: agents[data.agentId]?.isAdmin === true,
        });
      } else {
        logger.warn({ data }, 'Invalid bind_identity request');
      }
      break;

    case 'update_agent':
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_agent attempt blocked',
        );
        break;
      }
      if (data.agentId && deps.setAgent) {
        const existing = agents[data.agentId];
        if (!existing) {
          logger.warn({ agentId: data.agentId }, 'Agent not found for update');
          break;
        }
        deps.setAgent({
          ...existing,
          displayName: data.displayName || existing.displayName,
          profile: data.profile || existing.profile,
          policyOverrides: data.policyOverrides || existing.policyOverrides,
          status: data.status || existing.status,
          isAdmin:
            data.profile === 'admin'
              ? true
              : data.profile
                ? false
                : existing.isAdmin,
        });
      }
      break;

    case 'disable_identity':
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized disable_identity attempt blocked',
        );
        break;
      }
      if (data.chatJid && deps.setIdentityBinding) {
        const existing = bindings[data.chatJid];
        if (!existing) break;
        deps.setIdentityBinding({
          ...existing,
          enabled: false,
        });
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
