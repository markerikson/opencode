import { test, expect, afterEach } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"

const bus = Bus.layer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(bus)),
  bus,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

const originalTrigger = Permission._triggerPluginHook.fn

afterEach(() => {
  Permission._triggerPluginHook.fn = originalTrigger
})

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const items = yield* permission.list()
        if (items.length === count) return items
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

it.instance(
  "plugin hook is called when rule evaluates to ask",
  () =>
    Effect.gen(function* () {
      let hookCalled = false
      let hookInfo: Permission.Request | undefined

      Permission._triggerPluginHook.fn = (info, output) => {
        hookCalled = true
        hookInfo = info
        return Effect.succeed(output)
      }

      const fiber = yield* ask({
        id: PermissionID.make("per_hook1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      expect(hookCalled).toBe(true)
      expect(hookInfo?.permission).toBe("bash")

      yield* reply({
        requestID: PermissionID.make("per_hook1"),
        reply: "once",
      })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

it.instance(
  "plugin hook auto-allow skips user prompt",
  () =>
    Effect.gen(function* () {
      Permission._triggerPluginHook.fn = (_info, _output) => {
        return Effect.succeed({ status: "allow" as const })
      }

      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      expect(result).toBeUndefined()

      // Verify no pending permissions (was auto-approved)
      const pending = yield* list()
      expect(pending.length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "plugin hook auto-deny throws DeniedError",
  () =>
    Effect.gen(function* () {
      Permission._triggerPluginHook.fn = (_info, _output) => {
        return Effect.succeed({ status: "deny" as const })
      }

      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
    }),
  { git: true },
)

it.instance(
  "plugin hook error falls through to user prompt",
  () =>
    Effect.gen(function* () {
      // Intentionally return a failing effect to test error fallthrough.
      // callPluginHook wraps this with catch/catchDefect.
      Permission._triggerPluginHook.fn = (() =>
        Effect.fail(new Error("plugin crashed"))) as unknown as typeof Permission._triggerPluginHook.fn

      const fiber = yield* ask({
        id: PermissionID.make("per_hook_err"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      // Should fall through to pending despite hook error
      yield* waitForPending(1)
      const pending = yield* list()
      expect(pending.some((p) => p.id === PermissionID.make("per_hook_err"))).toBe(true)

      yield* reply({
        requestID: PermissionID.make("per_hook_err"),
        reply: "once",
      })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

it.instance(
  "plugin hook is not called when rule is allow",
  () =>
    Effect.gen(function* () {
      let hookCalled = false
      Permission._triggerPluginHook.fn = (_info, output) => {
        hookCalled = true
        return Effect.succeed(output)
      }

      yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })

      expect(hookCalled).toBe(false)
    }),
  { git: true },
)

it.instance(
  "plugin hook is not called when rule is deny",
  () =>
    Effect.gen(function* () {
      let hookCalled = false
      Permission._triggerPluginHook.fn = (_info, output) => {
        hookCalled = true
        return Effect.succeed(output)
      }

      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(hookCalled).toBe(false)
    }),
  { git: true },
)
