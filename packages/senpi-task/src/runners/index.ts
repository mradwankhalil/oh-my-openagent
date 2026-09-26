export {
  DEFAULT_MAX_CHILD_DEPTH,
  InProcessRunner,
  RunnerError,
  childVisibleToolNames,
  filterSharedParentTools,
  isTaskOrTeamFamilyTool,
  mergeChildCustomTools,
} from "./in-process"
export { childStructuralToolNames, SENPI_SESSION_BUILTIN_NAMES } from "./in-process/host-tools"
export type {
  ChildCompletionPolicy,
  ChildHandle,
  ChildSession,
  ChildSessionEvent,
  ChildSessionListener,
  ChildSpec,
  CreateChildSession,
  DepthPolicy,
  InProcessRunnerOptions,
  RunnerFailure,
  RunnerOutcome,
  SharedToolFilterOptions,
} from "./in-process"
export { buildSubagentPrompt, type SubagentPromptInput } from "./in-process/subagent-prompt"
export { createChildResourceLoader } from "./in-process/child-loader"
export { RpcProcessRunner } from "./rpc-process"
export type { RpcProcessRunnerOptions } from "./rpc-process"
export { isHostSessionHandle, RpcHostRunner } from "./rpc-host"
export {
  ensureTaskDaemon,
  HostUnavailableError,
  resolveTaskHostSocket,
  TASK_DAEMON_REQUIRED_CAPABILITIES,
  TASK_HOST_SOCKET_ENV_NAMES,
} from "./rpc-host/daemon"
export type { EnsuredTaskDaemon, EnsureTaskDaemonInput, HostUnavailableReason } from "./rpc-host/daemon"
export { readMemberSessionIdentity, readSessionContext, readSessionRole, SESSION_ROLES } from "./rpc-host/session-role"
export type { MemberSessionIdentity, SessionRole } from "./rpc-host/session-role"
export type {
  CreateHostSessionChannel,
  EnsureTaskDaemonPort,
  FallbackChildRunner,
  HostSessionChannel,
  RpcHostRunnerOptions,
} from "./rpc-host"
export type { HostSessionChildHandle, HostSessionFacts } from "./rpc-host/handle-port"
export type {
  ChildEventListener,
  ChildExitFacts,
  ChildExitOutcome,
  RpcChildHandle,
  RpcRunnerSpec,
  RunnerErrorFacts,
  TerminateOptions,
} from "./types"
export {
  buildChildArgs,
  buildRpcSpawn,
  OMO_SENPI_TASK_RPC_CHILD,
  detectBunBinary,
  detectCompiledEngine,
  resolveChildSessionDir,
  resolveSenpiExecutable,
  resolveSenpiLauncher,
} from "./rpc/spawn"
export type { RpcSpawnDescriptor, RpcSpawnRuntime, SenpiLauncher } from "./rpc/spawn"
export { parseExtensionEntries } from "./rpc/parent-extensions"
export { classifyChildExit, mapExitOutcomeToError, tailStderr } from "./rpc/exit-mapping"
export type { ChildExitInput } from "./rpc/exit-mapping"
export { terminateRpcChild } from "./rpc/terminate"
export { RpcProtocolClient } from "./rpc/protocol-client"
export type { MalformedLineHandler, RpcProtocolClientOptions } from "./rpc/protocol-client"
export { createRpcChildHandle } from "./rpc/handle"
export type { CreateRpcChildHandleOptions } from "./rpc/handle"
export { RpcCommandError } from "./rpc/errors"
export { buildAutoUiResponse } from "./rpc/ui-auto-answer"
