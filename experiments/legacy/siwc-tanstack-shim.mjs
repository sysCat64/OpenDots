// HISTORICAL PROBE: not production code, and not a model of how to integrate.
//
// This is one of the proofs of concept that led to the ChatGPT plan provider.
// It reaches into the Sign in with ChatGPT DevKit's INTERNAL storage
// (dist/storage.js, ConnectionStore) to read the access token, with a throwaway
// in-memory key and no compatibility checks. The production implementation is
// src/server/chatgpt-devkit.ts and src/server/devkit-compat.ts, which validate
// what they read and refuse what they do not recognize. Kept for reference only;
// it may stop working whenever the DevKit changes.
//
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  mkdtemp,
  rm,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  spawn,
} from "node:child_process";

import {
  chat,
  maxIterations,
  toolDefinition,
} from "@tanstack/ai";

import {
  createOpenaiChat,
} from "@tanstack/ai-openai";

import {
  z,
} from "zod";

import {
  createChatGPT,
} from "../../../sign-in-with-chatgpt-devkit/packages/local/dist/index.js";

import {
  ConnectionStore,
} from "../../../sign-in-with-chatgpt-devkit/packages/local/dist/storage.js";


// ============================================================
// Configuration
// ============================================================

const requestedModel =
  process.argv[2] ?? "gpt-5.6-luna";

const storageDir =
  await mkdtemp(
    join(
      tmpdir(),
      "opendots-siwc-tanstack-shim-",
    ),
  );


// ============================================================
// Temporary credential encryption
//
// PoC専用。
// 本番実装ではOS-backed credential storageへ置き換える。
// ============================================================

const key =
  randomBytes(32);

const credentialEncryption = {
  id:
    "opendots-poc-aes-gcm-v1",

  isAvailable() {
    return true;
  },

  encrypt(plaintext) {
    const nonce =
      randomBytes(12);

    const cipher =
      createCipheriv(
        "aes-256-gcm",
        key,
        nonce,
      );

    const ciphertext =
      Buffer.concat([
        cipher.update(
          plaintext,
          "utf8",
        ),

        cipher.final(),
      ]);

    return Buffer.concat([
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  },

  decrypt(ciphertext) {
    const bytes =
      Buffer.from(ciphertext);

    const nonce =
      bytes.subarray(
        0,
        12,
      );

    const authTag =
      bytes.subarray(
        12,
        28,
      );

    const encrypted =
      bytes.subarray(28);

    const decipher =
      createDecipheriv(
        "aes-256-gcm",
        key,
        nonce,
      );

    decipher.setAuthTag(
      authTag,
    );

    return Buffer.concat([
      decipher.update(
        encrypted,
      ),

      decipher.final(),
    ]).toString("utf8");
  },
};


// ============================================================
// Sign in with ChatGPT client
// ============================================================

const chatgpt =
  createChatGPT({
    appName:
      "OpenDots SIWC TanStack Shim PoC",

    appId:
      "opendots-siwc-tanstack-shim-poc",

    redirectPort: 0,

    storageDir,

    credentialEncryption,

    openBrowser(url) {
      const child =
        spawn(
          "/usr/bin/open",
          [url],
          {
            detached: true,
            stdio: "ignore",
          },
        );

      child.unref();
    },
  });

let connected = false;


// ============================================================
// SIWC / TanStack compatibility shim
//
// Sign in with ChatGPTでは現在:
//
//   response.output_item.done
//       -> function_callあり
//
//   response.completed.output
//       -> []
//
// となる。
//
// TanStack Responses adapterはresponse.completed.outputを見て
// finishReasonを決めるため、実際にはTool Callが存在しても
//
//   finishReason = "stop"
//
// になってしまう。
//
// このshimでは、そのturn中にTOOL_CALL_*を観測していた場合、
//
//   stop -> tool_calls
//
// に補正する。
// ============================================================

function createSiwcTanStackShim(
  baseAdapter,
  {
    forcedFirstToolName,
  } = {},
) {
  return new Proxy(
    baseAdapter,
    {
      get(
        target,
        property,
      ) {
        if (
          property ===
          "chatStream"
        ) {
          return async function* (
            options,
          ) {
            /*
             * このPoCでは最初のturnだけToolを強制する。
             *
             * TanStackがToolを実行すると、
             * 次のturnではrole:"tool"メッセージが存在する。
             *
             * そのturnではtool_choice:noneにして、
             * 最終回答を生成させる。
             *
             * 本番OpenDotsではこの強制処理は不要。
             */
            const hasToolResult =
              options.messages.some(
                (message) =>
                  message.role ===
                  "tool",
              );

            const modelOptions = {
              ...(
                options.modelOptions ??
                {}
              ),
            };

            if (
              forcedFirstToolName
            ) {
              modelOptions.tool_choice =
                hasToolResult
                  ? "none"
                  : {
                      type:
                        "function",

                      name:
                        forcedFirstToolName,
                    };
            }

            let sawToolCall =
              false;

            for await (
              const chunk
              of target.chatStream({
                ...options,

                modelOptions,
              })
            ) {
              if (
                chunk.type ===
                  "TOOL_CALL_START" ||
                chunk.type ===
                  "TOOL_CALL_END"
              ) {
                sawToolCall =
                  true;
              }

              /*
               * SIWC compatibility fix.
               *
               * Tool Callを実際に観測しているのに
               * Responses adapterがstopを返した場合のみ補正。
               */
              if (
                chunk.type ===
                  "RUN_FINISHED" &&
                sawToolCall &&
                chunk.finishReason ===
                  "stop"
              ) {
                console.log("");
                console.log(
                  "[SIWC SHIM]",
                  "finishReason:",
                  "stop -> tool_calls",
                );

                yield {
                  ...chunk,

                  finishReason:
                    "tool_calls",
                };

                continue;
              }

              yield chunk;
            }
          };
        }

        const value =
          Reflect.get(
            target,
            property,
            target,
          );

        /*
         * class methodをProxy越しに呼ぶ場合、
         * thisがProxyにならないよう元adapterへbindする。
         */
        if (
          typeof value ===
          "function"
        ) {
          return value.bind(
            target,
          );
        }

        return value;
      },
    },
  );
}


// ============================================================
// Main
// ============================================================

try {
  console.log(
    "Opening Sign in with ChatGPT...",
  );

  const session =
    await chatgpt.signIn({
      newProfile: true,

      label:
        "OpenDots TanStack Shim PoC",
    });

  connected = true;

  if (!session.sharing) {
    throw new Error(
      "ChatGPT plan sharing is not enabled.",
    );
  }

  console.log(
    `Connected as: ${
      session.identity?.name ??
      "unknown"
    }`,
  );


  // ==========================================================
  // Discover available models
  // ==========================================================

  const models =
    await chatgpt.listModels();

  const selectedModel =
    models.find(
      (model) =>
        model.slug ===
        requestedModel,
    );

  if (!selectedModel) {
    console.error("");
    console.error(
      `Model not available: ${requestedModel}`,
    );

    console.table(
      models.map(
        (model) => ({
          slug:
            model.slug,

          name:
            model.displayName,
        }),
      ),
    );

    process.exitCode = 1;
  } else {
    console.log(
      `Using model: ${selectedModel.displayName} (${selectedModel.slug})`,
    );


    // ========================================================
    // Retrieve OAuth token
    //
    // PoC限定でDevKit内部Storageを直接読む。
    // token自体はログ出力しない。
    // ========================================================

    const connectionStore =
      new ConnectionStore(
        storageDir,
        credentialEncryption,
      );

    const saved =
      await connectionStore.withLock(
        () =>
          connectionStore.read(),
      );

    const activeProfile =
      saved?.profiles.find(
        (profile) =>
          profile.id ===
          saved.activeProfileId,
      );

    const accessToken =
      activeProfile
        ?.credentials
        ?.accessToken;

    if (!accessToken) {
      throw new Error(
        "ChatGPT OAuth access token was not available.",
      );
    }


    // ========================================================
    // Local Tool
    // ========================================================

    let toolExecutionCount =
      0;

    const getPocStatus =
      toolDefinition({
        name:
          "get_opendots_poc_status",

        description:
          "Get the authoritative current status of the OpenDots Sign in with ChatGPT proof of concept.",

        inputSchema:
          z.object({
            topic:
              z.string(),
          }),
      }).server(
        async ({
          topic,
        }) => {
          toolExecutionCount +=
            1;

          console.log("");
          console.log(
            `[LOCAL TOOL EXECUTED] get_opendots_poc_status("${topic}")`,
          );

          return {
            openDotsBaseline:
              "PASS",

            signInWithChatGPT:
              "PASS",

            tanstackResponses:
              "PASS",

            model:
              selectedModel.slug,

            functionCallGeneration:
              "PASS",

            tanstackAutomaticToolExecution:
              "PASS",

            compatibilityShim:
              "ACTIVE",
          };
        },
      );


    // ========================================================
    // Base OpenAI Responses adapter
    // ========================================================

    const baseAdapter =
      createOpenaiChat(
        selectedModel.slug,
        accessToken,
        {
          baseURL:
            "https://api.openai.com/v1",
        },
      );


    // ========================================================
    // Wrap with SIWC compatibility shim
    // ========================================================

    const adapter =
      createSiwcTanStackShim(
        baseAdapter,
        {
          /*
           * PoCを決定論的にするため、
           * 最初のturnだけこのToolを強制。
           */
          forcedFirstToolName:
            getPocStatus.name,
        },
      );


    // ========================================================
    // TanStack automatic agent loop
    // ========================================================

    console.log("");
    console.log(
      "========================================",
    );

    console.log(
      "Starting TanStack automatic Tool Loop",
    );

    console.log(
      "========================================",
    );


    const stream =
      chat({
        adapter,

        messages: [
          {
            role:
              "user",

            content:
              "OpenDots Sign in with ChatGPT PoCの現在の状態を確認してください。" +
              "必ず提供されたツールから得た情報だけを使い、" +
              "最後に日本語で簡潔に状態を説明してください。",
          },
        ],

        tools: [
          getPocStatus,
        ],

        agentLoopStrategy:
          maxIterations(3),

        modelOptions: {
          store: false,
        },
      });


    // ========================================================
    // Observe the complete TanStack stream
    // ========================================================

    let finalText =
      "";

    let chunkCount =
      0;

    let sawToolCall =
      false;

    let sawToolResult =
      false;

    const finishReasons =
      [];


    for await (
      const chunk
      of stream
    ) {
      chunkCount +=
        1;


      // ------------------------------------------------------
      // Tool Call lifecycle
      // ------------------------------------------------------

      if (
        chunk.type ===
        "TOOL_CALL_START"
      ) {
        sawToolCall =
          true;

        console.log("");
        console.log(
          `[TanStack] TOOL_CALL_START: ${
            chunk.toolCallName ??
            chunk.toolName ??
            "unknown"
          }`,
        );
      }


      if (
        chunk.type ===
        "TOOL_CALL_END"
      ) {
        console.log(
          "[TanStack] TOOL_CALL_END",
        );

        console.dir(
          chunk.input,
          {
            depth: null,
            colors: true,
          },
        );
      }


      if (
        chunk.type ===
        "TOOL_CALL_RESULT"
      ) {
        sawToolResult =
          true;

        console.log(
          "[TanStack] TOOL_CALL_RESULT",
        );
      }


      // ------------------------------------------------------
      // Assistant output
      // ------------------------------------------------------

      if (
        chunk.type ===
          "TEXT_MESSAGE_CONTENT" &&
        chunk.delta
      ) {
        finalText +=
          chunk.delta;
      }


      // ------------------------------------------------------
      // Each agent-loop turn
      // ------------------------------------------------------

      if (
        chunk.type ===
        "RUN_FINISHED"
      ) {
        const reason =
          chunk.metadata
            ?.tanstack
            ?.finishReason ??
          chunk.finishReason ??
          "unknown";

        finishReasons.push(
          reason,
        );

        console.log(
          `[TanStack] RUN_FINISHED: ${reason}`,
        );
      }


      // ------------------------------------------------------
      // Error
      // ------------------------------------------------------

      if (
        chunk.type ===
        "RUN_ERROR"
      ) {
        console.error("");
        console.error(
          "[TanStack] RUN_ERROR",
        );

        console.dir(
          chunk,
          {
            depth: null,
            colors: true,
          },
        );
      }
    }


    // ========================================================
    // Result
    // ========================================================

    console.log("");
    console.log(
      "========================================",
    );

    console.log(
      "FINAL ANSWER",
    );

    console.log(
      "========================================",
    );

    console.log(
      finalText ||
      "(no text response)",
    );

    console.log(
      "========================================",
    );

    console.log("");
    console.log(
      `Chunks: ${chunkCount}`,
    );

    console.log(
      `Tool calls observed: ${
        sawToolCall
          ? "YES"
          : "NO"
      }`,
    );

    console.log(
      `Tool executions: ${toolExecutionCount}`,
    );

    console.log(
      `Tool result event observed: ${
        sawToolResult
          ? "YES"
          : "NO"
      }`,
    );

    console.log(
      `Finish reasons: ${finishReasons.join(" -> ")}`,
    );


    // ========================================================
    // PASS / FAIL
    // ========================================================

    if (
      sawToolCall &&
      toolExecutionCount > 0 &&
      finalText.length > 0
    ) {
      console.log("");
      console.log(
        "✅ TanStack + SIWC Shim PoC: PASS",
      );

      console.log("");
      console.log(
        "ChatGPT Plus",
      );

      console.log(
        "   → SIWC OAuth",
      );

      console.log(
        "   → TanStack Responses Adapter",
      );

      console.log(
        "   → SIWC finishReason shim",
      );

      console.log(
        "   → Function Call",
      );

      console.log(
        "   → TanStack automatic local Tool execution",
      );

      console.log(
        "   → function_call_output",
      );

      console.log(
        "   → next agent iteration",
      );

      console.log(
        "   → final answer",
      );
    } else {
      console.log("");
      console.log(
        "❌ TanStack + SIWC Shim PoC: FAIL",
      );

      process.exitCode =
        1;
    }
  }
} catch (error) {
  console.error("");
  console.error(
    "PoC failed:",
  );

  console.error({
    name:
      error?.name,

    code:
      error?.code,

    message:
      error?.message,
  });

  process.exitCode = 1;
} finally {
  if (connected) {
    try {
      await chatgpt.disconnect();
    } catch (error) {
      console.warn(
        "Disconnect warning:",
        error?.message ??
          error,
      );
    }
  }

  await rm(
    storageDir,
    {
      recursive: true,
      force: true,
    },
  );
}