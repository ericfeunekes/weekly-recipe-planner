import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// These relevant shapes are transcribed from one updater-generated app-server
// schema bundle. They are compatibility evidence, not a Codex version allowlist.
export const GENERATED_CODEX_AUTH_NOTIFICATION_OPT_OUT_METHODS = Object.freeze([
  "account/rateLimits/updated",
  "account/updated",
  "remoteControl/status/changed",
]);

export function createGeneratedCodexAuthSchemaDocuments() {
  return structuredClone({
    "v1/InitializeParams.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "InitializeParams",
      type: "object",
      required: ["clientInfo"],
      properties: {
        clientInfo: { type: "object" },
        capabilities: {
          anyOf: [
            { $ref: "#/definitions/InitializeCapabilities" },
            { type: "null" },
          ],
        },
      },
      definitions: {
        InitializeCapabilities: {
          type: "object",
          properties: {
            experimentalApi: { type: "boolean", default: false },
            optOutNotificationMethods: {
              type: ["array", "null"],
              items: { type: "string" },
            },
          },
        },
      },
    },
    "ServerNotification.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "ServerNotification",
      oneOf: [
        ["account/login/completed", "AccountLoginCompletedNotification"],
        ["account/rateLimits/updated", "AccountRateLimitsUpdatedNotification"],
        ["account/updated", "AccountUpdatedNotification"],
        ["remoteControl/status/changed", "RemoteControlStatusChangedNotification"],
      ].map(([method, definition]) => ({
        type: "object",
        required: ["method", "params"],
        properties: {
          method: { type: "string", enum: [method] },
          params: { $ref: `#/definitions/${definition}` },
        },
      })),
      definitions: {
        AccountLoginCompletedNotification: { type: "object" },
        AccountRateLimitsUpdatedNotification: { type: "object" },
        AccountUpdatedNotification: { type: "object" },
        RemoteControlStatusChangedNotification: { type: "object" },
      },
    },
    "v2/GetAccountParams.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "GetAccountParams",
      type: "object",
      properties: {
        refreshToken: { type: "boolean" },
      },
    },
    "v2/GetAccountResponse.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "GetAccountResponse",
      type: "object",
      required: ["requiresOpenaiAuth"],
      properties: {
        account: {
          anyOf: [{ $ref: "#/definitions/Account" }, { type: "null" }],
        },
        requiresOpenaiAuth: { type: "boolean" },
      },
      definitions: {
        Account: {
          oneOf: [
            {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string", enum: ["apiKey"], title: "ApiKeyAccountType" },
              },
              title: "ApiKeyAccount",
            },
            {
              type: "object",
              required: ["email", "planType", "type"],
              properties: {
                email: { type: ["string", "null"] },
                planType: { $ref: "#/definitions/PlanType" },
                type: { type: "string", enum: ["chatgpt"], title: "ChatgptAccountType" },
              },
              title: "ChatgptAccount",
            },
            {
              type: "object",
              required: ["type"],
              properties: {
                credentialSource: {
                  default: "awsManaged",
                  allOf: [{ $ref: "#/definitions/AmazonBedrockCredentialSource" }],
                },
                type: {
                  type: "string",
                  enum: ["amazonBedrock"],
                  title: "AmazonBedrockAccountType",
                },
              },
              title: "AmazonBedrockAccount",
            },
          ],
        },
        AmazonBedrockCredentialSource: {
          type: "string",
          enum: ["codexManaged", "awsManaged"],
        },
        PlanType: {
          type: "string",
          enum: [
            "free",
            "go",
            "plus",
            "pro",
            "prolite",
            "team",
            "self_serve_business_usage_based",
            "business",
            "enterprise_cbp_usage_based",
            "enterprise",
            "edu",
            "unknown",
          ],
        },
      },
    },
    "v2/LoginAccountParams.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "LoginAccountParams",
      oneOf: [
        {
          type: "object",
          required: ["apiKey", "type"],
          properties: {
            apiKey: { type: "string" },
            type: { type: "string", enum: ["apiKey"] },
          },
          title: "ApiKeyv2::LoginAccountParams",
        },
        {
          type: "object",
          required: ["type"],
          properties: {
            codexStreamlinedLogin: { type: "boolean" },
            type: { type: "string", enum: ["chatgpt"] },
          },
          title: "Chatgptv2::LoginAccountParams",
        },
        {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["chatgptDeviceCode"] },
          },
          title: "ChatgptDeviceCodev2::LoginAccountParams",
        },
        {
          description: "Internal token login alternative; not selected by the planner.",
          type: "object",
          required: ["accessToken", "chatgptAccountId", "type"],
          properties: {
            accessToken: { type: "string" },
            chatgptAccountId: { type: "string" },
            chatgptPlanType: { type: ["string", "null"] },
            type: { type: "string", enum: ["chatgptAuthTokens"] },
          },
          title: "ChatgptAuthTokensv2::LoginAccountParams",
        },
      ],
    },
    "v2/LoginAccountResponse.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "LoginAccountResponse",
      oneOf: [
        {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: ["apiKey"] } },
        },
        {
          type: "object",
          required: ["authUrl", "loginId", "type"],
          properties: {
            authUrl: { type: "string" },
            loginId: { type: "string" },
            type: { type: "string", enum: ["chatgpt"] },
          },
        },
        {
          type: "object",
          required: ["loginId", "type", "userCode", "verificationUrl"],
          properties: {
            loginId: { type: "string" },
            type: { type: "string", enum: ["chatgptDeviceCode"] },
            userCode: { type: "string" },
            verificationUrl: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: ["chatgptAuthTokens"] } },
        },
      ],
    },
    "v2/CancelLoginAccountParams.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "CancelLoginAccountParams",
      type: "object",
      required: ["loginId"],
      properties: { loginId: { type: "string" } },
    },
    "v2/CancelLoginAccountResponse.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "CancelLoginAccountResponse",
      type: "object",
      required: ["status"],
      properties: {
        status: { $ref: "#/definitions/CancelLoginAccountStatus" },
      },
      definitions: {
        CancelLoginAccountStatus: {
          type: "string",
          enum: ["canceled", "notFound"],
        },
      },
    },
    "v2/LogoutAccountResponse.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "LogoutAccountResponse",
      type: "object",
    },
    "v2/AccountLoginCompletedNotification.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "AccountLoginCompletedNotification",
      type: "object",
      required: ["success"],
      properties: {
        error: { type: ["string", "null"] },
        loginId: { type: ["string", "null"] },
        success: { type: "boolean" },
      },
    },
  });
}

export async function writeGeneratedCodexAuthSchemaFixture(
  directory,
  documents = createGeneratedCodexAuthSchemaDocuments(),
) {
  for (const [relativePath, document] of Object.entries(documents)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  }
  return directory;
}

// Updated only when the semantic generated-schema fixture intentionally changes.
export const GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT =
  "6b9c052842f304402b5ddac3ba6bc7606b852ebebaa70a35d4da5c26708be719";

export function assertGeneratedAuthSchemaFixtureFingerprint(value) {
  const actual = typeof value === "string" ? value : value?.authSchemaFingerprint;
  if (actual !== GENERATED_CODEX_AUTH_SCHEMA_FIXTURE_FINGERPRINT) {
    throw new Error("The fake-auth test did not use the grounded generated auth schema fixture.");
  }
  return actual;
}
