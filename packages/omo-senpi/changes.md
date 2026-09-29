## model-profile, task: builtin lanes and the category notice never route to an unlisted gateway (#9146)

- `components/model-profile/resolve.ts`: every builtin rung, in `recommended` and in the `daily-*`/`geeky-*` lanes, is
  served only by its listed providers, so a lane never lands the session on a gateway's copy of its model
  (`opengateway/anthropic/claude-opus-5-5`). A lane no listed provider serves is `unavailable` and keeps the session
  model with the existing one-line notice. A user's bare model id, which names no provider, still matches anywhere.
  `rankedProvidersOnly` is gone: it was the only builtin that had the listed-only rule, which is now the rule.
- `components/task/category-unavailable-warning.ts`: when only an unlisted provider serves a hidden category's chain,
  the one notice per session names it and the exact opt-in line
  (`categories.<name>.model = "<gateway>/<model>"`); `details.unlisted_provider_model` carries it for remote clients.

