---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, bootstrap the owner's admin agent, provision family member agents, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## Mental Model

- NanoClaw now runs as one orchestrator with first-class personal agents.
- Each person gets their own agent, workspace, session history, tools, memory, and policy profile.
- Chats are linked to agents through identity bindings. A private chat should map to exactly one personal agent.
- v1 multi-user setup is private-chat only. Do not use shared family/group chats as the primary endpoint.
- The owner's private chat is the admin agent. Additional family members are separate `adult` or `child` agents.
- The setup CLI still reports some legacy `registered_groups` signals. Treat those as compatibility/migration state, not the desired long-term model.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `ambroseacoulter/nanoclaw-oi` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned NanoClaw directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `ambroseacoulter/nanoclaw-oi` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw-oi.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/ambroseacoulter/nanoclaw-oi.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/ambroseacoulter/nanoclaw-oi.git
```

**Case C — both `origin` (user's fork) and `upstream` (ambroseacoulter) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `ambroseacoulter/nanoclaw-oi.git`.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing legacy registrations. These are migrated into `agents` + `identity_bindings` at runtime, so preserve them unless the user explicitly wants to reconfigure.
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 4b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

**Registration rule for multi-user installs:** the first chat you register should be the owner's private 1:1 chat, and it should be marked as the main/admin chat if the channel skill offers that choice. Do not bootstrap the system around a shared family group.

## 6. Bootstrap the Owner Admin Agent

The owner must end setup with one working private chat bound to the admin agent.

- Use the private chat that was registered in step 5 as the owner's admin identity.
- Keep the existing workspace folder if this install is being migrated from a legacy main group. The runtime now treats that workspace as the owner's personal agent workspace.
- If you need to explain the data model to the user, use this wording: one `Agent` per person, one or more `IdentityBinding` rows per agent, profiles `admin` / `adult` / `child`, and policy overrides for per-user limits.
- Do not promise a separate setup CLI for family-member provisioning. Today the setup scripts still bootstrap the first identity through the legacy registration flow, and the runtime migrates that into the new agent model automatically.

## 7. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

Use the admin-only mount policy by default:
- The owner/admin agent may need broader access for development or repo changes.
- Child agents should not receive extra writable mounts.
- Adult agents should only get what they need for their own workspace.

## 8. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 9. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 8
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5. This is still the compatibility signal the setup verifier uses before runtime migration creates `agents` and `identity_bindings`.
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test the owner's private admin chat first. Show: `tail -f logs/nanoclaw.log`

## 10. Provision Additional Family Members

Only do this after step 9 succeeds.

- Scope v1 to private chats only.
- Create one personal agent per family member.
- Use `admin` for the owner, `adult` for unrestricted personal agents without admin rights, and `child` for restricted agents.
- Apply per-user policy overrides for exceptions such as disabling code changes, shell access, or `opencode`.
- Support linked identities by binding multiple private chats to the same person only when that is intentional.

Preferred workflow:
1. Confirm the owner/admin agent is live and responding in their private chat.
2. For each family member, collect `displayName`, stable slug/workspace folder, profile, and their private chat identity per channel.
3. Provision them through the admin agent using the runtime admin tools or invoke `/manage-users`: create the agent, bind their chat identity, then update profile overrides if needed.
4. Verify isolation by messaging each bound private chat separately and confirming they do not share memory, tasks, or workspace state.

Do not auto-create unknown users from inbound messages. Unknown private chats should remain unbound until the admin explicitly provisions them.

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 8), missing `.env` (step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in the affected agent workspace under `groups/<workspace-folder>/logs/container-*.log`.

**No response to messages:** Check that the chat is bound to an agent and that the channel is configured. Owner/admin private chat does not need a trigger. Other private bindings should behave as personal endpoints once provisioned. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Child can access tools they should not have:** Review the agent's profile and policy overrides. `child` should deny file mutation, arbitrary shell, privileged integrations, and admin actions unless explicitly overridden.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
