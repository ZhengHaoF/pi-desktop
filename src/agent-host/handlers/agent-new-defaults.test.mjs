import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

// agent.new 的默认分支回归：缺少 type 且没有正文时只能建会话，不能跑空回合。
// 手机端曾经只传 {cwd}，被兜底成 {type:'prompt', message:''}，一进新任务页
// 就凭空多出一条「已加载这个项目…还没收到具体任务」的助手消息。
const { createAgentHandlers, fixture } = await importTestBundle("agent-new-defaults", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export {createAgentHandlers} from "./agent.ts"; export * as fixture from "../rpc-manager";',
  },
  plugins: [
    {
      name: "agent-new-defaults-fixture",
      setup(build) {
        build.onResolve(
          { filter: /^\.\.\/(rpc-manager|session-reader|session-readonly|file-access|session-change)$/ },
          (args) => ({ path: args.path, namespace: "agent-new-defaults" }),
        );
        build.onLoad({ filter: /.*/, namespace: "agent-new-defaults" }, ({ path: module }) => ({
          loader: "js",
          contents: module.endsWith("rpc-manager")
            ? `
      export const calls=[];
      const session={inner:{},modelSelection:{snapshot:()=>undefined},send:async command=>{calls.push(command);return null;}};
      export function getRpcSession(){return session;}
      export async function startRpcSession(){return{session,realSessionId:'new-session'};}
    `
            : module.endsWith("session-reader")
              ? "export async function resolveSessionPath(){return undefined;}"
              : module.endsWith("session-readonly")
                ? 'export function readSessionSnapshot(){throw new Error("not used");}'
                : module.endsWith("file-access")
                  ? "export function allowFileRoot(){}"
                  : "export async function emitIndexedSessionChange(){}",
        }));
      },
    },
  ],
});

const handlers = createAgentHandlers({ server: { emit() {} }, bindEvents() {} });

test("agent.new without a type and without a message only ensures a session", async () => {
  fixture.calls.length = 0;
  const result = await handlers.new({ cwd: process.cwd() });
  assert.equal(result.sessionId, "new-session");
  assert.deepEqual(fixture.calls, [], "an empty prompt turn must not be started");

  fixture.calls.length = 0;
  await handlers.new({ cwd: process.cwd(), message: "   " });
  assert.deepEqual(fixture.calls, [], "whitespace-only messages are not a task");
});

test("agent.new keeps sending prompt commands that carry a message", async () => {
  fixture.calls.length = 0;
  await handlers.new({ cwd: process.cwd(), message: "  看看转向灯为什么闪得快  " });
  assert.deepEqual(fixture.calls, [{ type: "prompt", message: "  看看转向灯为什么闪得快  " }]);

  fixture.calls.length = 0;
  await handlers.new({ cwd: process.cwd(), type: "steer", message: "先别改那个文件" });
  assert.deepEqual(fixture.calls, [{ type: "steer", message: "先别改那个文件" }], "explicit types pass through");
});
