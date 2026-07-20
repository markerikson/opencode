import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect, afterEach, describe } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"

import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const noopPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (_name: any, _input: any, output: any) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap], [Plugin.node, noopPlugin]],
)
const it = testEffect(env)

// Save original hook function for restoration after each test
const originalHookFn = Permission._triggerPluginHook.fn

afterEach(() => {
  Permission._triggerPluginHook.fn = originalHookFn
})

const makeAskInput = (overrides?: Partial<PermissionV1.AskInput>): PermissionV1.AskInput => ({
  sessionID: SessionID.make("session_test"),
  permission: "edit",
  patterns: ["/tmp/test.txt"],
  metadata: { title: "Edit file", description: "test" },
  always: ["/tmp/test.txt"],
  ruleset: [],
  ...overrides,
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

describe("permission.ask plugin hook", () => {
  it.instance(
    "calls plugin hook when permission needs asking",
    () =>
      Effect.gen(function* () {
        let hookCalled = false
        let hookInput: PermissionV1.AskInput | undefined
        let hookOutput: { status: PermissionV1.Action } | undefined

        Permission._triggerPluginHook.fn = (info, output) => {
          hookCalled = true
          hookInput = info
          hookOutput = output
          // Return "ask" to continue normal flow (prompt user)
          return Effect.succeed({ status: "ask" as PermissionV1.Action })
        }

        const permission = yield* Permission.Service
        const input = makeAskInput()

        // ask() will block waiting for user reply, so run in fiber
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
        yield* waitForPending(1)

        expect(hookCalled).toBe(true)
        expect(hookInput).toBeDefined()
        expect(hookInput!.permission).toBe("edit")
        expect(hookOutput).toBeDefined()
        expect(hookOutput!.status).toBe("ask")

        // Clean up: reject to unblock the fiber
        const list = yield* permission.list()
        yield* permission.reply({ requestID: list[0].id, reply: "reject" })
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "auto-allows when plugin hook returns allow",
    () =>
      Effect.gen(function* () {
        Permission._triggerPluginHook.fn = (_info, _output) => {
          return Effect.succeed({ status: "allow" as PermissionV1.Action })
        }

        const permission = yield* Permission.Service
        const input = makeAskInput()

        // Should complete immediately without blocking for user input
        yield* permission.ask(input)

        // No pending requests since hook auto-allowed
        const list = yield* permission.list()
        expect(list.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "auto-denies when plugin hook returns deny",
    () =>
      Effect.gen(function* () {
        Permission._triggerPluginHook.fn = (_info, _output) => {
          return Effect.succeed({ status: "deny" as PermissionV1.Action })
        }

        const permission = yield* Permission.Service
        const input = makeAskInput()

        const exit = yield* Effect.exit(permission.ask(input))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
        }
      }),
    { git: true },
  )

  it.instance(
    "falls through to user prompt when hook throws",
    () =>
      Effect.gen(function* () {
        Permission._triggerPluginHook.fn = (_info, _output) => {
          return Effect.fail(new Error("plugin crashed"))
        }

        const permission = yield* Permission.Service
        const input = makeAskInput()

        // Should fall through to normal ask flow (block for user)
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
        yield* waitForPending(1)

        // The request should be pending (hook error was caught, fell through)
        const list = yield* permission.list()
        expect(list.length).toBe(1)

        // Clean up
        yield* permission.reply({ requestID: list[0].id, reply: "reject" })
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "falls through to user prompt when hook throws a defect",
    () =>
      Effect.gen(function* () {
        Permission._triggerPluginHook.fn = (_info, _output) => {
          return Effect.die("plugin defect")
        }

        const permission = yield* Permission.Service
        const input = makeAskInput()

        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
        yield* waitForPending(1)

        const list = yield* permission.list()
        expect(list.length).toBe(1)

        yield* permission.reply({ requestID: list[0].id, reply: "reject" })
        yield* Fiber.await(fiber)
      }),
    { git: true },
  )

  it.instance(
    "does not call hook when rules already allow",
    () =>
      Effect.gen(function* () {
        let hookCalled = false

        Permission._triggerPluginHook.fn = (info, output) => {
          hookCalled = true
          return Effect.succeed({ status: "ask" as PermissionV1.Action })
        }

        const permission = yield* Permission.Service
        const input = makeAskInput({
          ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
        })

        // Should complete immediately - rules allow it, no hook needed
        yield* permission.ask(input)

        expect(hookCalled).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "does not call hook when rules deny",
    () =>
      Effect.gen(function* () {
        let hookCalled = false

        Permission._triggerPluginHook.fn = (info, output) => {
          hookCalled = true
          return Effect.succeed({ status: "ask" as PermissionV1.Action })
        }

        const permission = yield* Permission.Service
        const input = makeAskInput({
          ruleset: [{ permission: "edit", pattern: "*", action: "deny" }],
        })

        const exit = yield* Effect.exit(permission.ask(input))
        expect(Exit.isFailure(exit)).toBe(true)

        // Hook should NOT be called when rules explicitly deny
        expect(hookCalled).toBe(false)
      }),
    { git: true },
  )
})
