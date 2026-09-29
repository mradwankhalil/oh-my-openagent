## skill-commands, skills: argument-taking skills wait for their arguments in the slash picker (#9168)

- `skills/{hyperplan,init-deep,mass-ulw,ulw-loop,ulw-plan,ulw-research}/SKILL.md` and the shared-pool
  `ulw-execute`, `refactor` and `remove-ai-slops` declare `argument-hint`. From senpi#2258 on, the picker reads it
  (`Skill.argumentHint`) and Enter on a `skill:<name>` row fills `/skill:<name> ` and waits instead of submitting the
  skill empty. Skills that take no arguments stay hint-less and still submit on one Enter.
- `components/skill-commands/autocomplete.ts`: a bare alias row mirrors its own `skill:<name>` row on the same page,
  taking its description (which carries the hint) and `awaitsArguments`, so `/ulw-execute` waits exactly when
  `/skill:ulw-execute` does. `pi.getCommands()` carries no hint, so the page row is the source. Without the skill row
  the alias falls back to the command description and submits as before.
- `components/skill-commands/argument-hints.test.ts` parses every shipped SKILL.md with the engine's own
  `parseFrontmatter` (native copy over the shared one, as `sync-skills.mjs` ships them) and pins the set of hinted
  skills.

## computer-use, x-search: a feature skill yields to a loaded same-name skill and honors disabled_skills (#9160)

- `components/bundled-skills/contributed-skill.ts`: `resolveContributedSkill` decides one `resources_discover` pass for a
  skill a component contributes on its own. `disabled_skills` hides it (`readDisabledSkills`, now shared with the
  bundled-skills component). A `skill:<name>` entry in `pi.getCommands()` whose `sourceInfo.path` is not ours means
  senpi already loaded a same-name skill, which wins first-path either way, so ours is withheld instead of becoming a
  "Skill conflicts" collision. Our own path left over from an earlier pass still contributes.
- `components/computer-use/index.ts`: the `computer-use` skill goes through it; `/computer status` adds
  `skill: your own computer-use skill is active in place of the built-in guide (<path>)` when it yielded. New `env`
  option for the config read.
- `components/x-search/index.ts`: the conditional `x-search` skill goes through it. Both tools stay registered.
- `extension/types.ts`: `getCommands()` entries carry the optional `sourceInfo.path` senpi already reports.

## memory: a late Kibitzer verdict no longer steers an extra turn after the final answer

- `components/memory/kibitzer/delivery.ts`: an accepted verdict steers at once only while the running session has a
  tool call executing. The host reads its steering queue after every turn, so a steer queued once the final answer
  was streaming or streamed started one more assistant turn after it; a headless `senpi -p` consumer that posts only
  the last assistant text then lost the real answer (observed as `answer -> omo-kibitzer:recall -> "NO_REPLY"`). Such a
  verdict is now held for the next `tool_result` steer or the next prompt's drain, like any other held nudge.
- `components/memory/kibitzer/hooks.ts`: `tool_call` / `tool_result` report the executing call ids to delivery, and a
  new `turn_end` hook clears them so a call that never reports a result (blocked, aborted) cannot outlive its turn.

## model-profile, task: builtin lanes and the category notice never route to an unlisted gateway (#9146)

- `components/model-profile/resolve.ts`: every builtin rung, in `recommended` and in the `daily-*`/`geeky-*` lanes, is
  served only by its listed providers, so a lane never lands the session on a gateway's copy of its model
  (`opengateway/anthropic/claude-opus-5-5`). A lane no listed provider serves is `unavailable` and keeps the session
  model with the existing one-line notice. A user's bare model id, which names no provider, still matches anywhere.
  `rankedProvidersOnly` is gone: it was the only builtin that had the listed-only rule, which is now the rule.
- `components/task/category-unavailable-warning.ts`: when only an unlisted provider serves a hidden category's chain,
  the one notice per session names it and the exact opt-in line
  (`categories.<name>.model = "<gateway>/<model>"`); `details.unlisted_provider_model` carries it for remote clients.

