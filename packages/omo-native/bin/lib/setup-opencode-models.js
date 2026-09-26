/**
 * Reads the model choices an OpenCode user made - the opencode config's `model`, `small_model` and
 * `agent.<name>` overrides, and the OpenCode edition's omo routing (`categories`, `agents`) - and
 * converts each into what the native harness reads. Provider ids go through provider-map.json, the
 * table the credential stage uses, and every provider/model is checked against the engine's model
 * list; what does not resolve is returned with its reason, never converted. Read-only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { opencodeConfigSources, readOpencodeConfig } from "./setup-opencode-assets.js"

// The OpenCode edition's legacy plugin files, highest precedence first, as its config migration
// discovers them (omo-opencode config-migration/discovery-paths.ts CONFIG_FILE_NAMES).
const EDITION_FILES = ["oh-my-openagent.jsonc", "oh-my-openagent.json", "oh-my-opencode.jsonc", "oh-my-opencode.json"]

// The agents the native harness defines (senpi-task agents/builtin/index.ts BUILTIN_AGENTS). Any
// other name would become a new promptless agent there, not the OpenCode agent the user tuned.
export const NATIVE_AGENT_NAMES = [
  "explore",
  "librarian",
  "omo-native-code-reviewer",
  "omo-native-gate-reviewer",
  "omo-native-qa-executor",
  "plan-consultant",
  "plan-reviewer",
]

// OpenCode's own primary agents: the native main session has no per-mode agent, it runs the default model.
const OPENCODE_PRIMARY_AGENTS = new Set(["build", "plan"])

// omo-config-core schema/legacy-category-names.ts: the loader renames these and reports it.
const CATEGORY_ALIASES = { deep: "deep-low" }

// omo-config-core schema/reasoning-vocabulary.ts levels, plus the `none` and `auto` spellings it accepts.
const REASONING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "none"])
const MODEL_KEYS = ["model", "models", "fallback_models"]

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function record(value) {
  return isPlainObject(value) ? value : {}
}

function readProviderMap() {
  return JSON.parse(readFileSync(new URL("./provider-map.json", import.meta.url), "utf8"))
}

// The first start of any current harness runs the config unification migration, which keeps none
// of a legacy file's categories or agents and moves the file to
// `~/.omo/migration-backup-<timestamp>-opencode-config/<path relative to home>`
// (omo-opencode config-migration/migration-plans.ts). The newest moved copy stands in for it.
function editionFile(path, home, notices) {
  if (existsSync(path)) return path
  const inHome = relative(home, path)
  const root = join(home, ".omo")
  if (inHome.startsWith("..") || isAbsolute(inHome) || !existsSync(root)) return path
  const moved = readdirSync(root)
    .filter((name) => /^migration-backup-.+-opencode-config$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(root, name, inHome))
    .find((candidate) => existsSync(candidate))
  if (moved === undefined) return path
  notices.push(`NOTICE opencode: ${path} was moved to ${moved} by the omo config migration; its model routing is read from there`)
  return moved
}

/**
 * The raw choices, before any translation. `opencodeBlock` is the `[opencode]` block of the user's
 * omo.json[c]: the unification migration's target, so an entry there wins over the legacy files.
 */
export function readModelChoices({ home, env, opencodeBlock }) {
  const notices = []
  const opencode = readOpencodeConfig(opencodeConfigSources(home, env).files, "model choices", notices)
  const globalDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
  const explicitDir = env.OPENCODE_CONFIG_DIR?.trim()
  const directories = explicitDir ? [resolve(explicitDir), globalDir] : [globalDir]
  // readOpencodeConfig lets later files win, so the highest-precedence file is read last.
  const legacyFiles = directories
    .flatMap((directory) => EDITION_FILES.map((name) => editionFile(join(directory, name), home, notices)))
    .reverse()
  const edition = readOpencodeConfig(legacyFiles, "model choices", notices)
  const block = record(opencodeBlock)
  return {
    model: typeof opencode.model === "string" ? opencode.model : undefined,
    smallModel: typeof opencode.small_model === "string" ? opencode.small_model : undefined,
    opencodeAgents: record(opencode.agent),
    categories: { ...record(edition.categories), ...record(block.categories) },
    agents: { ...record(edition.agents), ...record(block.agents) },
    notices,
  }
}

function hasModelChoice(entry) {
  return isPlainObject(entry) && MODEL_KEYS.some((key) => entry[key] !== undefined)
}

export function hasModelChoices(raw) {
  return raw.model !== undefined || raw.smallModel !== undefined
    || [raw.opencodeAgents, raw.categories, raw.agents].some((entries) => Object.values(entries).some(hasModelChoice))
}

function engineProvider(provider, modelId, context) {
  const { providerMap, oauthProviders, registry } = context
  // A provider opencode signed in to with OAuth (`openai` through a ChatGPT plan) is served here by
  // the provider the credential stage says to `/login` to (provider-map.json `oauthLogins`), not by
  // the same id, which would need an API key the user never had.
  const login = oauthProviders.has(provider) && Object.hasOwn(providerMap.oauthLogins, provider) ? providerMap.oauthLogins[provider] : undefined
  if (login !== undefined && registry.models.get(login)?.has(modelId)) return login
  if (providerMap.builtinProviderIds.includes(provider)) return provider
  return providerMap.providers[provider] ?? provider
}

// `provider/model`, optionally with a `:level` or legacy `(level)` reasoning suffix. `max` is also a
// model-id ending, so it only counts as a suffix on a provider-qualified id (reasoning-vocabulary.ts).
function splitSuffix(text) {
  const paren = /^(.*\S)\s*\(([^()]+)\)$/.exec(text)
  if (paren && REASONING.has(paren[2].trim().toLowerCase())) return { selector: paren[1], suffix: `:${paren[2].trim().toLowerCase()}` }
  const colon = text.lastIndexOf(":")
  const token = text.slice(colon + 1).toLowerCase()
  if (colon <= 0 || !REASONING.has(token) || (token === "max" && !text.slice(0, colon).includes("/"))) return { selector: text, suffix: "" }
  return { selector: text.slice(0, colon), suffix: `:${token}` }
}

/** `{ ref, provider, modelId }` for a model string the engine serves, else `{ reason }`. */
export function translateModelRef(raw, context) {
  if (typeof raw !== "string" || raw.trim() === "") return { reason: "not a model string" }
  const { selector, suffix } = splitSuffix(raw.trim())
  const slash = selector.indexOf("/")
  if (slash <= 0) {
    // A bare id is matched against every provider by the native resolver, so any provider serving it will do.
    const served = [...context.registry.models.values()].some((ids) => ids.has(selector))
    return served ? { ref: `${selector}${suffix}`, modelId: selector } : { reason: `no omo provider serves a model named ${selector}` }
  }
  const source = selector.slice(0, slash)
  const modelId = selector.slice(slash + 1)
  const provider = engineProvider(source, modelId, context)
  const ids = context.registry.models.get(provider)
  if (ids === undefined) return { reason: `provider ${source} is not one omo serves or was carried over` }
  if (!ids.has(modelId)) {
    return {
      reason: context.registry.dynamic.has(provider)
        ? `${provider} lists its models only at runtime, so ${modelId} could not be checked`
        : `omo's ${provider} provider has no model ${modelId}`,
    }
  }
  return { ref: `${provider}/${modelId}${suffix}`, provider, modelId }
}

function reasoningOf(entry) {
  for (const key of ["reasoning", "reasoningEffort", "variant"]) {
    if (typeof entry[key] === "string" && entry[key].trim() !== "") return entry[key].trim()
  }
  return undefined
}

function temperatureOf(entry) {
  return typeof entry.temperature === "number" && entry.temperature >= 0 && entry.temperature <= 2 ? entry.temperature : undefined
}

function tuning(entry) {
  const reasoning = reasoningOf(entry)
  const temperature = temperatureOf(entry)
  return { ...(reasoning !== undefined ? { reasoning } : {}), ...(temperature !== undefined ? { temperature } : {}) }
}

function chainItem(item, take) {
  if (typeof item === "string") return take(item)
  if (!isPlainObject(item)) return undefined
  const model = take(item.model)
  return model === undefined ? undefined : { model, ...tuning(item) }
}

/**
 * The native shape of one category or agent entry: `model`, `models`, `reasoning`, `temperature`.
 * A deprecated `fallback_models` chain is folded into `models` behind `model`, the order the
 * OpenCode edition tried them in. Undefined when the entry named models and none of them resolve:
 * its tuning alone would retune the builtin chain the user had replaced.
 */
function convertEntry(label, entry, context, dropped) {
  const take = (raw) => {
    const result = translateModelRef(raw, context)
    if (result.reason !== undefined) dropped.push(`${label} model ${String(raw)}: ${result.reason}`)
    return result.ref
  }
  const folded = !Array.isArray(entry.models) && entry.fallback_models !== undefined
  const chain = Array.isArray(entry.models)
    ? entry.models
    : folded ? [entry.model, ...[entry.fallback_models].flat()].filter((item) => item !== undefined) : []
  const model = !folded && entry.model !== undefined ? take(entry.model) : undefined
  const models = chain.map((item) => chainItem(item, take)).filter((item) => item !== undefined)
  if (hasModelChoice(entry) && model === undefined && models.length === 0) return undefined
  const converted = {
    ...(model !== undefined ? { model } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...tuning(entry),
  }
  return Object.keys(converted).length > 0 ? converted : undefined
}

function convertAgents(raw, context, dropped) {
  const agents = new Map()
  const native = new Set(NATIVE_AGENT_NAMES)
  // opencode.json `agent.<name>` first, so the OpenCode edition's own `agents.<name>` wins over it.
  for (const [origin, entries] of [["opencode agent", raw.opencodeAgents], ["agent", raw.agents]]) {
    for (const [name, entry] of Object.entries(entries)) {
      if (!hasModelChoice(entry)) continue
      if (!native.has(name)) {
        dropped.push(OPENCODE_PRIMARY_AGENTS.has(name) && origin === "opencode agent"
          ? `${origin} ${name}: the OpenCode primary agent; omo's main session runs the default model instead`
          : `${origin} ${name}: omo has no agent of that name (its agents: ${NATIVE_AGENT_NAMES.join(", ")}); route that work through a category instead`)
        continue
      }
      const converted = convertEntry(`${origin} ${name}`, entry, context, dropped)
      if (converted !== undefined) agents.set(name, converted)
    }
  }
  return [...agents].map(([name, entry]) => ({ name, entry })).sort((left, right) => left.name.localeCompare(right.name))
}

function convertCategories(raw, context, dropped) {
  const categories = new Map()
  for (const [name, entry] of Object.entries(raw.categories)) {
    if (!isPlainObject(entry)) continue
    const target = Object.hasOwn(CATEGORY_ALIASES, name) ? CATEGORY_ALIASES[name] : name
    // A canonical key beside its retired alias wins, as the loader resolves the pair.
    if (target !== name && Object.hasOwn(raw.categories, target)) continue
    const converted = convertEntry(`category ${name}`, entry, context, dropped)
    if (converted !== undefined) categories.set(target, converted)
  }
  return [...categories].map(([name, entry]) => ({ name, entry })).sort((left, right) => left.name.localeCompare(right.name))
}

function convertDefault(model, context, dropped) {
  if (model === undefined) return undefined
  const result = translateModelRef(model, context)
  if (result.reason !== undefined) {
    dropped.push(`default model ${model}: ${result.reason}`)
    return undefined
  }
  if (result.provider === undefined) {
    dropped.push(`default model ${model}: names no provider, and omo's default model needs one`)
    return undefined
  }
  return { source: model, provider: result.provider, modelId: result.modelId, ref: `${result.provider}/${result.modelId}` }
}

/**
 * The raw choices converted against `registry` (engine-models.js `loadEngineModels`).
 * `oauthProviders` are the opencode provider ids whose opencode credential is an OAuth login.
 */
export function convertModelChoices(raw, registry, oauthProviders = new Set()) {
  const context = { registry, providerMap: readProviderMap(), oauthProviders }
  const dropped = []
  const defaultModel = convertDefault(raw.model, context, dropped)
  if (raw.smallModel !== undefined) dropped.push(`small_model ${raw.smallModel}: omo has no small-model setting`)
  const categories = convertCategories(raw, context, dropped)
  const agents = convertAgents(raw, context, dropped)
  return { defaultModel, categories, agents, dropped }
}
