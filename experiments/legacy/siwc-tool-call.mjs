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

const storageDir = await mkdtemp(
  join(
    tmpdir(),
    "opendots-siwc-tool-poc-",
  ),
);


// ============================================================
// Temporary credential encryption
//
// PoC専用。
// 暗号鍵はこのプロセスのメモリ上にだけ存在する。
// プロセス終了時にstorageDirも削除する。
// ============================================================

const key = randomBytes(32);

const credentialEncryption = {
  id: "opendots-poc-aes-gcm-v1",

  isAvailable() {
    return true;
  },

  encrypt(plaintext) {
    const nonce = randomBytes(12);

    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      nonce,
    );

    const ciphertext = Buffer.concat([
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
      bytes.subarray(0, 12);

    const authTag =
      bytes.subarray(12, 28);

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
      "OpenDots SIWC Tool PoC",

    appId:
      "opendots-siwc-tool-poc",

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
// Raw Responses API helper
// ============================================================

async function runResponse({
  accessToken,
  body,
}) {
  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(body),
      },
    );

  console.log(
    `HTTP ${response.status}`,
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Responses API failed: ${response.status}\n${errorText}`,
    );
  }

  if (!response.body) {
    throw new Error(
      "Responses API returned no response body.",
    );
  }

  const decoder =
    new TextDecoder();

  let buffer = "";

  let text = "";

  const outputItems = [];

  for await (
    const chunk of response.body
  ) {
    buffer +=
      decoder.decode(
        chunk,
        {
          stream: true,
        },
      );

    while (true) {
      const separator =
        buffer.indexOf("\n\n");

      if (separator === -1) {
        break;
      }

      const block =
        buffer.slice(
          0,
          separator,
        );

      buffer =
        buffer.slice(
          separator + 2,
        );

      for (
        const line
        of block.split("\n")
      ) {
        if (
          !line.startsWith(
            "data: ",
          )
        ) {
          continue;
        }

        const data =
          line.slice(6);

        if (
          data === "[DONE]"
        ) {
          continue;
        }

        let event;

        try {
          event =
            JSON.parse(data);
        } catch {
          continue;
        }

        console.log(
          `EVENT: ${event.type}`,
        );

        // --------------------------------
        // Assistant text
        // --------------------------------

        if (
          event.type ===
          "response.output_text.delta"
        ) {
          text +=
            event.delta ?? "";
        }

        // --------------------------------
        // Completed output items
        //
        // SIWCでは response.completed.output
        // が [] になることがあるので、
        // output_item.done を正とする。
        // --------------------------------

        if (
          event.type ===
          "response.output_item.done"
        ) {
          outputItems.push(
            event.item,
          );

          console.log(
            "OUTPUT ITEM:",
          );

          console.dir(
            event.item,
            {
              depth: null,
              colors: true,
            },
          );
        }

        // --------------------------------
        // Diagnostic only
        // --------------------------------

        if (
          event.type ===
          "response.completed"
        ) {
          console.log("");
          console.log(
            "response.completed.output:",
          );

          console.dir(
            event.response?.output,
            {
              depth: null,
              colors: true,
            },
          );

          console.log("");
        }
      }
    }
  }

  return {
    text,
    outputItems,
  };
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
        "OpenDots Tool PoC",
    });

  connected = true;

  if (!session.sharing) {
    throw new Error(
      "ChatGPT plan sharing is not enabled.",
    );
  }

  console.log(
    `Connected as: ${
      session.identity?.name
      ?? "unknown"
    }`,
  );


  // ==========================================================
  // Model discovery
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
    // Retrieve OAuth access token
    //
    // PoCなのでDevKit内部Storageを直接参照する。
    // access token自体は絶対にconsoleへ出さない。
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
    // Tool definition
    // ========================================================

    const tool = {
      type: "function",

      name:
        "get_opendots_poc_status",

      description:
        "Get the authoritative status of the OpenDots Sign in with ChatGPT PoC.",

      parameters: {
        type: "object",

        properties: {
          topic: {
            type: "string",
          },
        },

        required: [
          "topic",
        ],

        additionalProperties:
          false,
      },

      strict: true,
    };


    // ========================================================
    // TURN 1
    //
    // LunaにFunction Callを要求
    // ========================================================

    const firstUserMessage = {
      role: "user",

      content: [
        {
          type:
            "input_text",

          text:
            "OpenDots Sign in with ChatGPT PoCの現在の状態を確認してください。" +
            "必ず get_opendots_poc_status ツールを使用してください。" +
            "ツールを使わずに推測してはいけません。",
        },
      ],
    };


    console.log("");
    console.log(
      "========================================",
    );

    console.log(
      "TURN 1: Request tool call",
    );

    console.log(
      "========================================",
    );


    const first =
      await runResponse({
        accessToken,

        body: {
          model:
            selectedModel.slug,

          store: false,
          stream: true,

          include: [
            "reasoning.encrypted_content",
          ],

          input: [
            firstUserMessage,
          ],

          tools: [
            tool,
          ],

          tool_choice: {
            type:
              "function",

            name:
              "get_opendots_poc_status",
          },
        },
      });


    // ========================================================
    // Capture function_call
    //
    // IMPORTANT:
    // response.completed.output は空になるため、
    // response.output_item.done から取得する。
    // ========================================================

    const functionCall =
      first.outputItems.find(
        (item) =>
          item.type ===
          "function_call",
      );


    if (!functionCall) {
      throw new Error(
        "Function call was not produced.",
      );
    }


    console.log("");
    console.log(
      "Function call captured:",
    );

    console.dir(
      functionCall,
      {
        depth: null,
        colors: true,
      },
    );


    // ========================================================
    // Execute local tool
    // ========================================================

    let args;

    try {
      args =
        JSON.parse(
          functionCall.arguments,
        );
    } catch {
      throw new Error(
        `Could not parse function arguments: ${functionCall.arguments}`,
      );
    }


    console.log("");
    console.log(
      `[LOCAL TOOL EXECUTED] get_opendots_poc_status("${args.topic}")`,
    );


    const toolResult = {
      openDotsBaseline:
        "PASS",

      signInWithChatGPT:
        "PASS",

      responsesStreaming:
        "PASS",

      model:
        selectedModel.slug,

      functionCallGeneration:
        "PASS",

      localToolExecution:
        "PASS",
    };


    console.log("");
    console.log(
      "Tool result:",
    );

    console.dir(
      toolResult,
      {
        depth: null,
        colors: true,
      },
    );


    // ========================================================
    // TURN 2
    //
    // Function Call + Tool ResultをLunaへ返す
    //
    // store:falseなので、
    // 会話状態をこちらで再送する。
    // ========================================================

    console.log("");
    console.log(
      "========================================",
    );

    console.log(
      "TURN 2: Send tool result",
    );

    console.log(
      "========================================",
    );


    const second =
      await runResponse({
        accessToken,

        body: {
          model:
            selectedModel.slug,

          store: false,
          stream: true,

          include: [
            "reasoning.encrypted_content",
          ],

          input: [
            firstUserMessage,

            // TURN 1の完成済みoutput items
            ...first.outputItems,

            // ローカルToolの実行結果
            {
              type:
                "function_call_output",

              call_id:
                functionCall.call_id,

              output:
                JSON.stringify(
                  toolResult,
                ),
            },
          ],

          tools: [
            tool,
          ],

          // ここではToolを再度呼ばず、
          // 最終回答を生成させる。
          tool_choice:
            "none",
        },
      });


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
      second.text ||
      "(no text response)",
    );

    console.log(
      "========================================",
    );


    if (
      functionCall &&
      second.text
    ) {
      console.log("");
      console.log(
        "✅ Full Function Calling PoC: PASS",
      );

      console.log(
        "   ChatGPT Plus",
      );

      console.log(
        "      → SIWC OAuth",
      );

      console.log(
        "      → GPT",
      );

      console.log(
        "      → Function Call",
      );

      console.log(
        "      → Local Tool",
      );

      console.log(
        "      → function_call_output",
      );

      console.log(
        "      → Final Answer",
      );
    } else {
      console.log("");
      console.log(
        "❌ Full Function Calling PoC: FAIL",
      );

      process.exitCode = 1;
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