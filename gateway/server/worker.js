import { config } from "../config/index.js";
import { startFeishuLongConnection } from "../feishu/core/runtime.js";
import { bindThread, executeRun, reconcileStaleRunCardsOnStartup, requestRunAbort } from "./run-service.js";

function createRuntimeOps() {
  return {
    run: async (threadId, command, model, tool) => {
      await executeRun(threadId, command, model || undefined, tool || undefined);
    },
    bindWorkspace: async (threadId, repoPath, branch) => {
      bindThread(threadId, repoPath, branch);
    },
    requestRunAbort: (runId, reason) => requestRunAbort(runId, reason)
  };
}

export async function startGatewayWorker() {
  await reconcileStaleRunCardsOnStartup();
  const ops = createRuntimeOps();
  const mode = String(config.feishuConnectionMode || "long_connection").trim().toLowerCase();

  if (mode !== "long_connection") {
    throw new Error(`unsupported FEISHU_CONNECTION_MODE: ${mode}. only long_connection is enabled`);
  }

  await startFeishuLongConnection(ops.run, ops.bindWorkspace, ops.requestRunAbort);
  console.log("[gateway] mode=long_connection (sdk-only worker, no HTTP server)");
}
