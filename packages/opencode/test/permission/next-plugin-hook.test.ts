/**
 * Tests for the Plugin.trigger("permission.ask", ...) hook integration in PermissionNext.ask
 *
 * These tests use the _triggerPluginHook override to mock plugin behavior without
 * needing to mock the entire @/plugin module (which doesn't work well with bun's
 * mock.module for dynamic imports).
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// Track plugin trigger calls
let pluginTriggerCalls: Array<{ input: any }> = []
let pluginTriggerBehavior: { status: "ask" | "allow" | "deny" } | { error: Error } = { status: "ask" }

beforeEach(() => {
  pluginTriggerCalls = []
  pluginTriggerBehavior = { status: "ask" }

  // Override the plugin hook for testing
  PermissionNext._triggerPluginHook = async (info) => {
    pluginTriggerCalls.push({ input: info })
    if ("error" in pluginTriggerBehavior) {
      throw pluginTriggerBehavior.error
    }
    return { status: pluginTriggerBehavior.status }
  }
})

afterEach(() => {
  // Restore to use real plugin trigger
  PermissionNext._triggerPluginHook = null
})

test("ask - calls Plugin.trigger when rule evaluates to ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Plugin returns "ask", so it should fall through to pending promise
      pluginTriggerBehavior = { status: "ask" }

      const promise = PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: { foo: "bar" },
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      // Give the async function time to execute up to the hook call
      // The promise is returned after the hook completes (when status is "ask")
      await new Promise((r) => setTimeout(r, 50))

      // Should have called Plugin.trigger
      expect(pluginTriggerCalls.length).toBe(1)

      // Verify the request info was passed
      const passedInfo = pluginTriggerCalls[0].input
      expect(passedInfo.permission).toBe("bash")
      expect(passedInfo.patterns).toEqual(["ls"])
      expect(passedInfo.metadata).toEqual({ foo: "bar" })
      expect(passedInfo.sessionID).toBe("session_test")
      expect(passedInfo.id).toBeDefined() // auto-generated

      // Promise should be pending (plugin returned "ask")
      expect(promise).toBeInstanceOf(Promise)
    },
  })
})

test("ask - plugin can auto-allow permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Plugin sets status to "allow"
      pluginTriggerBehavior = { status: "allow" }

      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["dangerous-command"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      // Should resolve immediately without prompting user
      expect(result).toBeUndefined()
      expect(pluginTriggerCalls.length).toBe(1)
    },
  })
})

test("ask - plugin can auto-deny permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Plugin sets status to "deny"
      pluginTriggerBehavior = { status: "deny" }

      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["forbidden-command"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)

      expect(pluginTriggerCalls.length).toBe(1)
    },
  })
})

test("ask - plugin hook failure falls through to user prompt", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Make plugin throw an error
      pluginTriggerBehavior = { error: new Error("Plugin crashed!") }

      const promise = PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      // Give the async function time to execute up to the hook call
      await new Promise((r) => setTimeout(r, 50))

      // Should fall through to pending promise (user prompt)
      expect(promise).toBeInstanceOf(Promise)
      expect(pluginTriggerCalls.length).toBe(1)
    },
  })
})

test("ask - does not call plugin hook when rule is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })

      expect(result).toBeUndefined()
      // Plugin should NOT be called when static rule says "allow"
      expect(pluginTriggerCalls.length).toBe(0)
    },
  })
})

test("ask - does not call plugin hook when rule is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)

      // Plugin should NOT be called when static rule says "deny"
      expect(pluginTriggerCalls.length).toBe(0)
    },
  })
})
