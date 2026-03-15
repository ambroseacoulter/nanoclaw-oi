---
name: manage-users
description: Manage NanoClaw personal agents after setup. Use when the user wants to add or remove a family member, bind or disable a private chat identity, rename an agent, change profile or status, or update per-user policy overrides such as tool restrictions.
---

# Manage NanoClaw Users

This skill manages personal agents and their bound chat identities in a multi-user NanoClaw install.

Use it for:
- Creating a new family member agent
- Binding a private chat on WhatsApp, Telegram, Slack, or Discord to an existing agent
- Updating display name, profile, status, or policy overrides
- Disabling an identity so that chat stops routing to an agent

Do not use it for:
- Installing or authenticating a new channel integration. Invoke the relevant channel skill first.
- Shared group-chat routing design. v1 is private-chat first.
- Direct database surgery unless the runtime admin tools are unavailable and you have no safer path.

## Preconditions

- Prefer running this from the owner's admin agent.
- The relevant channel must already be installed and authenticated.
- Private chat identities should be provisioned explicitly. Do not auto-create unknown inbound users.

## Workflow

1. Confirm the request type: create user, bind identity, rename/update, or disable access.
2. Confirm you are operating on a private chat identity, not a shared group chat, unless the user explicitly wants a compatibility path.
3. Collect the minimum required fields.
4. Use the runtime admin tools instead of editing SQLite directly:
   - `create_agent`
   - `bind_identity`
   - `update_agent`
   - `disable_identity`
5. Verify the result by checking the updated routing behavior in the user's private chat.

## Data Model

- One `Agent` per person
- One or more `IdentityBinding` rows per agent
- Profiles:
  - `admin` for the owner
  - `adult` for unrestricted personal agents without admin rights
  - `child` for restricted personal agents
- Policy overrides refine the profile defaults for tools, mounts, remote control, and other privileged capabilities

## Create a User

Collect:
- `agent_id`: stable identifier, usually matching the workspace folder
- `slug`: human-readable stable slug
- `display_name`
- `workspace_folder`
- `profile`: `adult` or `child` in normal family setups

Then create the agent with `create_agent`.

Immediately after creation, bind at least one private chat identity with `bind_identity`.

Recommended conventions:
- Keep `agent_id`, `slug`, and `workspace_folder` aligned unless there is a strong reason not to.
- Use lowercase letters, numbers, and hyphens for stable identifiers.
- Keep the owner as the only `admin` unless the user explicitly wants multiple admins.

## Bind a Channel Identity

Collect:
- `agent_id`
- `chat_jid`
- `channel`
- `kind`
- `requires_trigger` when relevant

Use `bind_identity` for the new private chat.

Rules:
- Default to `kind=private`
- Bind multiple identities to one agent only when they truly represent the same person
- Do not bind an unverified chat identity just because it appears in logs

If the channel itself is missing or unauthenticated, stop and invoke the channel skill first:
- `/add-whatsapp`
- `/add-telegram`
- `/add-slack`
- `/add-discord`

## Update Name, Profile, or Limits

Use `update_agent` when changing:
- `display_name`
- `profile`
- `status`
- `policy_overrides_json`

Typical uses:
- Promote a family member from `child` to `adult`
- Disable code-editing or shell-like tools for a child
- Disable `opencode` for selected users
- Temporarily disable an agent without deleting workspace state

Policy guidance:
- Prefer profile defaults first, then add small overrides
- Keep child restrictions explicit and conservative
- Avoid granting admin-only capabilities through overrides unless the user explicitly requests it

## Disable Access

Use `disable_identity` when a specific private chat should stop routing to NanoClaw.

Use `update_agent` with `status=disabled` when the whole personal agent should be turned off.

Prefer disabling over deleting when you might need to preserve workspace, memory, or task history.

## Verification

After changes:
- Confirm the owner/admin agent still works in its private chat
- Send a test message from the newly bound or updated private chat
- Verify the message lands in the correct personal workspace and does not share memory with another user
- If a child policy changed, verify the denied capability is actually blocked

## Troubleshooting

**Admin tools are denied:** You are probably not running from the admin agent. Switch to the owner's admin chat.

**Messages from a new user do nothing:** Check that the channel is authenticated, the identity is bound, and the binding is enabled.

**Two people are sharing memory unexpectedly:** Check whether two private chats were bound to the same `agent_id`.

**A child still has too much access:** Re-run `update_agent` with stricter policy overrides and verify from that child's chat.
