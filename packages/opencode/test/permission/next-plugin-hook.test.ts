import { test, expect, afterEach } from "bun:test"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

const originalTrigger = Permission._triggerPluginHook

afterEach(async () => {
  Permission._triggerPluginHook = originalTrigger
  await Instance.disposeAll()
})

async function waitForPending(id: string, timeout = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const list = await Permission.list()
    if (list.some((p) => p.id === id)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for pending permission ${id}`)
}

test("plugin hook is called when rule evaluates to ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let hookCalled = false
      let hookInfo: Permission.Request | undefined

      Permission._triggerPluginHook = async (info, output) => {
        hookCalled = true
        hookInfo = info
        return output
      }

      const askPromise = Permission.ask({
        id: PermissionID.make("per_hook1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      await waitForPending("per_hook1")
      expect(hookCalled).toBe(true)
      expect(hookInfo?.permission).toBe("bash")

      await Permission.reply({
        requestID: PermissionID.make("per_hook1"),
        reply: "once",
      })
      await askPromise
    },
  })
})

test("plugin hook auto-allow skips user prompt", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Permission._triggerPluginHook = async (_info, _output) => {
        return { status: "allow" }
      }

      const result = await Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      expect(result).toBeUndefined()

      // Verify no pending permissions (was auto-approved)
      const pending = await Permission.list()
      expect(pending.length).toBe(0)
    },
  })
})

test("plugin hook auto-deny throws DeniedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Permission._triggerPluginHook = async (_info, _output) => {
        return { status: "deny" }
      }

      await expect(
        Permission.ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("plugin hook error falls through to user prompt", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Permission._triggerPluginHook = async () => {
        throw new Error("plugin crashed")
      }

      const askPromise = Permission.ask({
        id: PermissionID.make("per_hook_err"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      // Should fall through to pending despite hook error
      await waitForPending("per_hook_err")
      const pending = await Permission.list()
      expect(pending.some((p) => p.id === "per_hook_err")).toBe(true)

      await Permission.reply({
        requestID: PermissionID.make("per_hook_err"),
        reply: "once",
      })
      await askPromise
    },
  })
})

test("plugin hook is not called when rule is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let hookCalled = false
      Permission._triggerPluginHook = async (_info, output) => {
        hookCalled = true
        return output
      }

      await Permission.ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })

      expect(hookCalled).toBe(false)
    },
  })
})

test("plugin hook is not called when rule is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let hookCalled = false
      Permission._triggerPluginHook = async (_info, output) => {
        hookCalled = true
        return output
      }

      await expect(
        Permission.ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)

      expect(hookCalled).toBe(false)
    },
  })
})
