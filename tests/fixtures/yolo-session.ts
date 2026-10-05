import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import minimalPermissionExtension from "../../index.js";

export const YOLO_ENV = "PI_MINIMAL_PERMISSION_SYSTEM_YOLO";
export const WRITTEN_CONTENT = "written with inherited YOLO";

export async function createYoloSession(
  cwd: string,
  agentDir: string,
  flags: ReadonlyMap<string, boolean> = new Map(),
) {
  const faux = fauxProvider({ provider: "pi-yolo-integration-test" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const nestedCalls: { toolName: string; parentToolCallId: string }[] = [];
  const observeNestedCalls = (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event) => {
      if (event.parentToolCallId) {
        nestedCalls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
      }
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [createCodemodeExtension(), observeNestedCalls, minimalPermissionExtension],
  });
  await resourceLoader.reload();
  for (const [name, value] of flags) {
    resourceLoader.getExtensions().runtime.flagValues.set(name, value);
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      defaultTools: ["+codemode"],
      defaultProjectTrust: "always",
      compaction: { enabled: false },
    }),
  });
  try {
    await session.bindExtensions({});
  } catch (error) {
    session.dispose();
    throw error;
  }

  return {
    session,
    async write(path: string) {
      const firstNestedCall = nestedCalls.length;
      const code = `await tools.write(${JSON.stringify({ path, content: WRITTEN_CONTENT })});`;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Finished."),
      ]);
      await session.prompt("Run the supplied codemode write once.");
      const result = session.messages.filter((message) =>
        message.role === "toolResult" && "toolName" in message && message.toolName === "codemode",
      ).at(-1);
      if (!result || result.role !== "toolResult" || !("content" in result)) {
        throw new Error("The Pi session did not record a codemode result.");
      }
      return {
        text: result.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
        isError: result.isError,
        nestedCalls: nestedCalls.slice(firstNestedCall),
      };
    },
  };
}
